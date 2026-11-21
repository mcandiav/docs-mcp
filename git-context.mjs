import fs from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

const execFileAsync = promisify(execFile);

const gitLocks = new Map();

function toPosix(p) {
  return String(p ?? "").replace(/\\/g, "/");
}

function normalizeScopePrefix(scopePrefix) {
  const posix = toPosix(scopePrefix).replace(/^\/+|\/+$/g, "");
  return posix === "." ? "" : posix;
}

function isPathInside(parent, child) {
  const parentResolved = path.resolve(parent);
  const childResolved = path.resolve(child);
  if (parentResolved === childResolved) return true;
  const parentWithSep = parentResolved.endsWith(path.sep) ? parentResolved : parentResolved + path.sep;
  return childResolved.startsWith(parentWithSep);
}

async function assertRealPathInside(workspaceRoot, candidatePath) {
  const realRoot = await fs.realpath(workspaceRoot);
  let realCandidate;
  try {
    realCandidate = await fs.realpath(candidatePath);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error("El directorio seleccionado no existe.");
    }
    throw error;
  }

  if (!isPathInside(realRoot, realCandidate)) {
    throw new Error("Ruta fuera del workspace permitido (posible escape por symlink).");
  }

  return { realRoot, realCandidate };
}

async function runGit(gitRoot, args, options = {}) {
  const { maxBuffer = 10 * 1024 * 1024, env, input } = options;
  if (input == null) {
    return execFileAsync("git", args, {
      cwd: gitRoot,
      maxBuffer,
      env: env ? { ...process.env, ...env } : process.env
    });
  }

  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: gitRoot,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > maxBuffer) {
        settled = true;
        child.kill();
        reject(new Error("git stdout exceeded maxBuffer"));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const error = new Error(`git ${args.join(" ")} failed with code ${code}`);
      error.stdout = stdout;
      error.stderr = stderr;
      error.code = code;
      reject(error);
    });

    child.stdin.end(input);
  });
}

export async function withGitLock(lockKey, fn) {
  const key = String(lockKey || "default");
  const previous = gitLocks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const next = previous.then(() => gate);
  gitLocks.set(key, next);

  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (gitLocks.get(key) === next) {
      gitLocks.delete(key);
    }
  }
}

export function createGitContextResolver({
  workspaceRoot,
  normalizeRelativePath,
  resolveSafePath
}) {
  if (!workspaceRoot) throw new Error("workspaceRoot requerido.");
  if (typeof normalizeRelativePath !== "function") throw new Error("normalizeRelativePath requerido.");
  if (typeof resolveSafePath !== "function") throw new Error("resolveSafePath requerido.");

  async function resolveGitContext(relativeDir = ".") {
    const normalizedDir = normalizeRelativePath(relativeDir ?? ".", { allowWorkspaceRoot: true });
    const selectedPath = resolveSafePath(normalizedDir, { allowWorkspaceRoot: true });
    const st = await fs.stat(selectedPath).catch((error) => {
      if (error && error.code === "ENOENT") {
        throw new Error("relative_dir no existe.");
      }
      throw error;
    });
    if (!st.isDirectory()) {
      throw new Error("relative_dir debe ser un directorio.");
    }

    const { realRoot, realCandidate } = await assertRealPathInside(workspaceRoot, selectedPath);

    let gitRootRaw;
    try {
      const { stdout } = await runGit(realCandidate, ["rev-parse", "--show-toplevel"]);
      gitRootRaw = stdout.trim();
    } catch {
      throw new Error("No se encontro un repositorio Git para el directorio seleccionado.");
    }

    const gitRoot = path.resolve(gitRootRaw);
    const { realCandidate: realGitRoot } = await assertRealPathInside(workspaceRoot, gitRoot);

    if (!isPathInside(realGitRoot, realCandidate)) {
      throw new Error("El directorio seleccionado no pertenece al repositorio Git detectado.");
    }

    const scopePrefix = normalizeScopePrefix(path.relative(realGitRoot, realCandidate));
    const model = scopePrefix ? "shared" : "independent";

    let branch = "";
    try {
      const { stdout } = await runGit(realGitRoot, ["branch", "--show-current"]);
      branch = stdout.trim();
    } catch {
      branch = "";
    }

    const relativeDirOut = toPosix(path.relative(realRoot, realCandidate) || ".");
    const repoRootOut = toPosix(path.relative(realRoot, realGitRoot) || ".");

    return {
      relativeDir: relativeDirOut,
      selectedPath: realCandidate,
      gitRoot: realGitRoot,
      repoRoot: repoRootOut,
      branch,
      model,
      scopePrefix,
      lockKey: realGitRoot
    };
  }

  function assertWithinScope(ctx, repoRelativePath) {
    const rel = toPosix(repoRelativePath).replace(/^\/+/, "");
    if (!rel || rel === ".") {
      if (ctx.scopePrefix) {
        throw new Error("Ruta fuera del alcance autorizado del proyecto seleccionado.");
      }
      return ".";
    }

    if (rel.startsWith("../") || rel.includes("/../") || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) {
      throw new Error("Ruta Git invalida o fuera del alcance autorizado.");
    }

    if (!ctx.scopePrefix) return rel;

    if (rel === ctx.scopePrefix || rel.startsWith(`${ctx.scopePrefix}/`)) {
      return rel;
    }

    throw new Error(`Ruta fuera del alcance autorizado: ${rel}`);
  }

  function isInScope(ctx, repoRelativePath) {
    try {
      assertWithinScope(ctx, repoRelativePath);
      return true;
    } catch {
      return false;
    }
  }

  async function resolvePathUnderContext(ctx, relativePathFromSelected) {
    const normalized = normalizeRelativePath(relativePathFromSelected, { allowWorkspaceRoot: true });
    const absolute = normalized === "."
      ? ctx.selectedPath
      : path.resolve(ctx.selectedPath, normalized);

    if (!isPathInside(ctx.selectedPath, absolute) && path.resolve(absolute) !== path.resolve(ctx.selectedPath)) {
      throw new Error("Ruta fuera del directorio seleccionado.");
    }

    await assertRealPathInside(workspaceRoot, path.dirname(absolute));
    if (await fs.stat(absolute).then(() => true).catch(() => false)) {
      await assertRealPathInside(workspaceRoot, absolute);
    } else {
      // Validate parent chain stays inside workspace/selection without requiring file existence.
      if (!isPathInside(ctx.selectedPath, absolute)) {
        throw new Error("Ruta fuera del directorio seleccionado.");
      }
    }

    const repoRelative = toPosix(path.relative(ctx.gitRoot, absolute));
    return assertWithinScope(ctx, repoRelative);
  }

  async function listStatus(ctx) {
    const args = ["status", "--short", "--"];
    if (ctx.scopePrefix) args.push(ctx.scopePrefix);
    else args.push(".");
    const { stdout } = await runGit(ctx.gitRoot, args);
    return stdout.trim();
  }

  async function listDiff(ctx, { relativePath, staged = false } = {}) {
    const args = ["diff"];
    if (staged) args.push("--staged");
    args.push("--");

    if (relativePath) {
      const repoRelative = await resolvePathUnderContext(ctx, relativePath);
      args.push(repoRelative);
    } else if (ctx.scopePrefix) {
      args.push(ctx.scopePrefix);
    } else {
      args.push(".");
    }

    const { stdout } = await runGit(ctx.gitRoot, args, { maxBuffer: 10 * 1024 * 1024 });
    return stdout || "";
  }

  async function listStagedNames(ctx) {
    const { stdout } = await runGit(ctx.gitRoot, ["diff", "--cached", "--name-only", "-z"]);
    if (!stdout) return [];
    return stdout
      .split("\0")
      .map((p) => toPosix(p).replace(/^\/+/, ""))
      .filter(Boolean);
  }

  async function gitAdd(ctx, pathsFromSelected) {
    if (!Array.isArray(pathsFromSelected) || pathsFromSelected.length === 0) {
      throw new Error("paths debe contener al menos una ruta relativa.");
    }

    const repoPaths = [];
    for (const p of pathsFromSelected) {
      const repoRelative = await resolvePathUnderContext(ctx, p);
      repoPaths.push(repoRelative);
    }

    await runGit(ctx.gitRoot, ["add", "--", ...repoPaths]);
    return {
      paths: pathsFromSelected.map((p) => toPosix(normalizeRelativePath(p, { allowWorkspaceRoot: true }))),
      repoPaths,
      status: await listStatus(ctx)
    };
  }

  async function resolveIndexPath(ctx) {
    const { stdout } = await runGit(ctx.gitRoot, ["rev-parse", "--git-path", "index"]);
    const indexRel = stdout.trim();
    return path.isAbsolute(indexRel) ? indexRel : path.resolve(ctx.gitRoot, indexRel);
  }

  async function restoreOutOfScopeFromBackup(ctx, backupIndexPath, outOfScopePaths) {
    if (!outOfScopePaths.length) return;
    const { stdout } = await runGit(ctx.gitRoot, ["ls-files", "-s", "--", ...outOfScopePaths], {
      env: { GIT_INDEX_FILE: backupIndexPath }
    });
    if (!stdout.trim()) return;
    await runGit(ctx.gitRoot, ["update-index", "--index-info"], { input: stdout });
  }

  async function gitCommitScoped(ctx, message) {
    const staged = await listStagedNames(ctx);
    const inScope = staged.filter((p) => isInScope(ctx, p));
    const outOfScope = staged.filter((p) => !isInScope(ctx, p));

    if (inScope.length === 0) {
      throw new Error("No hay cambios preparados dentro del alcance seleccionado.");
    }

    // Independent repo / full-scope: normal commit when everything staged is in scope.
    if (outOfScope.length === 0) {
      return runGit(ctx.gitRoot, ["commit", "-m", message], { maxBuffer: 10 * 1024 * 1024 });
    }

    const indexPath = await resolveIndexPath(ctx);
    const backupPath = `${indexPath}.mcp-backup-${randomUUID()}`;
    await fs.copyFile(indexPath, backupPath);

    try {
      await runGit(ctx.gitRoot, ["reset", "-q", "HEAD", "--", ...outOfScope]);
      const result = await runGit(ctx.gitRoot, ["commit", "-m", message], { maxBuffer: 10 * 1024 * 1024 });
      await restoreOutOfScopeFromBackup(ctx, backupPath, outOfScope);
      return result;
    } catch (error) {
      try {
        await fs.copyFile(backupPath, indexPath);
      } catch {
        // best effort restore
      }
      throw error;
    } finally {
      await fs.unlink(backupPath).catch(() => {});
    }
  }

  async function listUnpushedFiles(ctx, remote, branch) {
    const remoteRef = `${remote}/${branch}`;
    try {
      await runGit(ctx.gitRoot, ["rev-parse", "--verify", remoteRef]);
    } catch {
      throw new Error(`No existe la referencia remota ${remoteRef}. No se puede validar el alcance del push.`);
    }

    const { stdout: countOut } = await runGit(ctx.gitRoot, ["rev-list", "--count", `${remoteRef}..HEAD`]);
    const ahead = Number(countOut.trim() || "0");
    if (!Number.isFinite(ahead) || ahead <= 0) {
      return { ahead: 0, files: [] };
    }

    const { stdout } = await runGit(ctx.gitRoot, ["diff", "--name-only", `${remoteRef}..HEAD`]);
    const files = stdout
      .split(/\r?\n/)
      .map((p) => toPosix(p).trim())
      .filter(Boolean);
    return { ahead, files };
  }

  async function gitPushScoped(ctx, { remote = "origin", branch } = {}) {
    const selectedRemote = (remote ?? "origin").trim() || "origin";
    let selectedBranch = (branch ?? "").trim();
    if (!selectedBranch) {
      const { stdout } = await runGit(ctx.gitRoot, ["branch", "--show-current"]);
      selectedBranch = stdout.trim();
    }
    if (!selectedBranch) {
      throw new Error("No se pudo resolver la rama actual para git_push.");
    }

    const { ahead, files } = await listUnpushedFiles(ctx, selectedRemote, selectedBranch);
    if (ahead === 0) {
      throw new Error("No hay commits pendientes para publicar.");
    }

    if (ctx.model === "shared") {
      const foreign = files.filter((f) => !isInScope(ctx, f));
      if (foreign.length > 0) {
        throw new Error(
          `Push rechazado: los commits pendientes incluyen rutas ajenas al alcance (${foreign.slice(0, 5).join(", ")}${foreign.length > 5 ? ", ..." : ""}).`
        );
      }
    }

    const result = await runGit(ctx.gitRoot, ["push", selectedRemote, selectedBranch], {
      maxBuffer: 10 * 1024 * 1024
    });
    return {
      ...result,
      remote: selectedRemote,
      branch: selectedBranch,
      ahead,
      files
    };
  }

  return {
    resolveGitContext,
    listStatus,
    listDiff,
    gitAdd,
    gitCommitScoped,
    gitPushScoped,
    assertWithinScope,
    isInScope,
    withGitLock
  };
}

export const __test__ = {
  toPosix,
  normalizeScopePrefix,
  isPathInside,
  assertRealPathInside,
  runGit
};
