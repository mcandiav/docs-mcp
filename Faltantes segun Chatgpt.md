| Prioridad | Faltante                                      | Motivo                                                               |
| --------- | --------------------------------------------- | -------------------------------------------------------------------- |
| Alta      | Reparar `git_status`                          | Sin estado Git no podemos confirmar cambios de forma confiable.      |
| Alta      | Reparar `git_diff`                            | Sin diff no podemos revisar exactamente qué cambió antes de cerrar.  |
| Alta      | Agregar `git_add`                             | Permite preparar cambios versionados.                                |
| Alta      | Agregar `git_commit`                          | Permite cerrar cambios documentales con trazabilidad.                |
| Media     | Agregar `git_log`                             | Permite revisar historial y versión anterior.                        |
| Media     | Agregar `git_restore` o `git_checkout_file`   | Permite revertir cambios puntuales sin depender de backups manuales. |
| Media     | Agregar lectura por rango de líneas           | Evita bloqueos al leer archivos grandes o con partes sensibles.      |
| Media     | Agregar patch por línea/sección               | Más seguro que reemplazar texto exacto grande.                       |
| Media     | Agregar preview de patch antes de aplicar     | Permite validar modificación sin tocar archivo.                      |
| Baja      | Agregar búsqueda ignorando carpetas generadas | Evita ruido de `.next`, `dist`, caches, build.                       |
