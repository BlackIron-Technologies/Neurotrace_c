# Desplegar el servidor de NeuroTrace

El camino recomendado para esta implementación es una VM Linux con Docker Compose, almacenamiento persistente y un túnel permanente de Cloudflare. La misma imagen funciona en una máquina propia. El servidor ejecuta una sola instancia y guarda su SQLite en un volumen; los clientes acceden mediante HTTPS y WebSocket.

No es necesario instalar el backend de escritorio, descargar el modelo ONNX ni compilar ejecutables de Windows o macOS en la VM. El Dockerfile instala únicamente las dependencias del servicio de sincronización. La VM debe mantenerse encendida. La disponibilidad también depende de su disco, red y conector de Cloudflare.

## 1. Preparar la VM

Usa una cuenta de servicio con acceso al repositorio y Docker Engine con el plugin Compose instalado siguiendo la [guía oficial de Docker](https://docs.docker.com/engine/install/). Conserva el directorio del proyecto en un disco persistente. Desde la raíz del checkout:

```sh
mkdir -p sync-server/.secrets
chmod 700 sync-server/.secrets
python3 - <<'PY'
from pathlib import Path
import os, secrets
path = Path('sync-server/.env')
with path.open('x') as target:
    os.chmod(path, 0o600)
    target.write('NEUROTRACE_SYNC_SETUP_KEY=' + secrets.token_urlsafe(48) + '\n')
PY
```

El archivo se crea sin sobrescribir uno existente. Contiene la clave para reclamar una red nueva y está excluido de Git. Resguárdalo; no lo compartas con los miembros del equipo. El token del túnel y esta clave cumplen funciones diferentes.

## 2. Crear un túnel permanente

En el panel de Cloudflare, crea un túnel administrado remotamente para esta VM. Necesitas una cuenta y un dominio gestionado en Cloudflare. En su ruta de aplicación publicada configura:

| Campo | Ejemplo |
|---|---|
| Hostname público | `memory.tu-dominio.com` |
| Servicio | `HTTP` |
| URL de origen, usando el Compose incluido | `http://neurotrace-sync:9473` |

Ese origen usa el nombre del servicio dentro de la red Docker. Si el conector se ejecuta directamente en el host, usa `http://127.0.0.1:9473`. Copia únicamente el token del túnel, no el comando completo de instalación. La [guía oficial de Cloudflare](https://developers.cloudflare.com/tunnel/get-started/) explica la creación de túneles y rutas.

Guárdalo en un archivo privado sin imprimirlo en pantalla:

```sh
umask 077
read -rsp 'Token del túnel: ' NEUROTRACE_TUNNEL_INPUT
printf '%s' "$NEUROTRACE_TUNNEL_INPUT" > sync-server/.secrets/tunnel-token
unset NEUROTRACE_TUNNEL_INPUT
```

El conector lee este secreto mediante `TUNNEL_TOKEN_FILE`, una opción documentada por [Cloudflare](https://developers.cloudflare.com/tunnel/reference/run-parameters/#token-file). NeuroTrace mantiene la autenticación de personas y agentes. Un inicio de sesión interactivo adicional de Cloudflare Access requiere integrar sus credenciales de servicio en los clientes; este build no incorpora esa integración, por lo que esta receta utiliza la autenticación propia de NeuroTrace.

## 3. Arrancar el servicio

Desde la raíz del checkout:

```sh
docker compose --env-file sync-server/.env \
  -f sync-server/compose.yml -f sync-server/compose.cloudflare.yml \
  up -d --build
```

El servicio se comprueba con un healthcheck y el conector espera a que esté saludable. Compose reinicia ambos procesos si fallan y después de un reinicio de Docker. El puerto del host permanece ligado a loopback; el acceso público se realiza por el túnel. La clave de bootstrap es una variable privada del proceso y el token del conector se monta como secreto de Docker Compose.

Comprueba el resultado:

```sh
docker compose --env-file sync-server/.env \
  -f sync-server/compose.yml -f sync-server/compose.cloudflare.yml ps
curl --fail https://memory.tu-dominio.com/v1/status
```

La respuesta debe indicar `protocol: 1`, una identidad `instance_id` y la capacidad `device_receipts`. Antes de reclamar la red, `initialized` será `false`. El endpoint público no devuelve memorias ni credenciales. Una dirección que responde no prueba por sí sola permisos ni recepción entre dispositivos.

## 4. Reclamar la red y conectar al equipo

En **NeuroTrace Settings → Team sync → Create a network**, indica la URL HTTPS, tu nombre, el nombre de la red, el proyecto y la clave de bootstrap del archivo privado. Realiza la transferencia de esa clave a tu dispositivo por un canal seguro.

Después invita a miembros o agentes desde el panel. Cada dispositivo obtiene su propia credencial. Usa **Copy device invitation** para otra máquina de la misma persona. Las invitaciones son de un solo uso y duran una hora. El servidor de sincronización comparte el contenido únicamente según las membresías del proyecto, aunque su operador puede leer el almacenamiento del servidor.

En una segunda máquina, abre un workspace vacío y acepta la invitación. Crea una memoria, pulsa **Check delivery** y confirma su recepción con MCP:

```json
{"action":"wait","thought_id":"ID_DE_LA_MEMORIA","wait_for_peers":1,"timeout_ms":10000}
```

Ese es el argumento del tool `neurotrace_sync`. `success: true` confirma las escrituras incluidas en la petición, la descarga hasta el checkpoint indicado y el acuse de otro dispositivo. No significa que una persona haya leído la memoria. Una máquina desconectada puede producir un timeout; la memoria sigue guardada y la sincronización automática continúa.

## 5. Actualizar y respaldar

Antes de actualizar el servicio, respalda su SQLite con la API de backup o detén el servidor antes de copiar el almacenamiento. Con el servicio detenido, el archivo principal y cualquier WAL pendiente deben conservarse juntos. Copia los respaldos fuera de la VM y protege también sus permisos. Las membresías, el historial y los recibos forman parte de la misma base.

Para desplegar una nueva versión del código:

```sh
docker compose --env-file sync-server/.env \
  -f sync-server/compose.yml -f sync-server/compose.cloudflare.yml \
  up -d --build
```

El volumen `neurotrace-sync` se mantiene. No uses `down -v` si necesitas conservarlo. No arranques múltiples servidores sobre la misma base ni un segundo volumen vacío detrás del mismo hostname: los clientes esperan el mismo historial. Las migraciones de 1.3.1 agregan identidades de dispositivo y recibos; actualiza servidor y clientes para utilizar estas confirmaciones.

## Servidor local desde el panel

**Use this computer as server** abre tres pasos: arrancar el servidor, pegar la URL HTTPS que entrega el administrador y verificarla. Los nombres de propietario/proyecto se completan con valores editables. La verificación compara la identidad del servidor local con la publicada. NeuroTrace no crea túneles, no inicia cloudflared y no solicita tokens de Cloudflare.

El administrador crea y mantiene el túnel con su panel, CLI o infraestructura como código. Un agente con acceso administrativo a Cloudflare puede encargarse de ese paso mediante esas herramientas externas. Después `neurotrace_host` con `action: setup` y `public_url` completa la red/proyecto y devuelve una invitación. Para disponibilidad continua el administrador ejecuta los servicios con Compose o un supervisor.

Si una máquina ya tiene memorias, `neurotrace_connect` requiere `publish_existing: true` para importarlas. Se crea un respaldo lógico cifrado dentro de la base local, se conservan los IDs distintos y se crea una copia con ID nuevo si el mismo ID tiene contenido diferente. La opción no sobrescribe silenciosamente el servidor. Revisa el informe de importación y conserva también un respaldo externo para recuperación ante fallos físicos.

## Compilaciones para los tres sistemas

El código Python es compartido, pero PyInstaller genera un bundle específico del sistema y arquitectura que lo ejecuta; consulta su [documentación multiplataforma](https://pyinstaller.org/en/stable/operating-mode.html). Para distribuir una actualización del backend empaquetado, genera artefactos de Windows, Linux y macOS en sus runners respectivos. Para soportar ambos tipos de Mac, construye y valida las arquitecturas correspondientes; un binario ARM no funciona en un Mac Intel por usar Rosetta.

El workflow `.github/workflows/build-backends.yml` ya separa los tres sistemas y ahora ejecuta las pruebas de sincronización y un smoke test MCP del binario de cada uno. No necesitas compilarlos manualmente en tu Windows. Ejecuta el workflow después de guardar los cambios en el repositorio remoto. Los artefactos de CI no se publican como release salvo que se elija esa opción.

Cambiar únicamente el HTML/CSS del panel requiere reconstruir la extensión. Cambiar estas herramientas MCP, los recibos o el sincronizador modifica Python y requiere actualizar los bundles distribuidos. Ejecutar el servidor en Docker o el backend desde fuentes no exige generar ejecutables de otros sistemas. En este entorno solo se ha construido y ejecutado el bundle Windows; los demás requieren sus runners.

## Configuración de cero a invitación con un agente

Pide: «Configura un servidor local de NeuroTrace usando la URL https://memory.tu-dominio.com y dame una invitación». El administrador debe haber creado el túnel y dirigirlo al puerto local elegido. El agente utiliza las herramientas MCP siguientes:

1. `neurotrace_host` con `action: start` y el puerto acordado inicia solamente NeuroTrace.
2. El administrador configura y mantiene el túnel por fuera de NeuroTrace. Si el agente tiene acceso administrativo a Cloudflare, puede hacerlo con sus herramientas de Cloudflare o la CLI autenticada; es una operación de administración independiente.
3. `neurotrace_host` con `action: setup`, `public_url` y nombres opcionales verifica la URL, inicializa el workspace, crea la red/proyecto y devuelve `invitation_url`. La clave inicial se usa internamente y no se devuelve al agente.
4. En otra máquina, `neurotrace_connect` recibe `invitation_url`. Si ya hay trabajo local, el usuario debe autorizar `publish_existing: true`; el informe identifica respaldo, importaciones y versiones preservadas.
5. `neurotrace_sync` con `action: wait` y `wait_for_peers: 1` comprueba la entrega. `neurotrace_team` permite crear invitaciones adicionales y administrar miembros conforme al rol.

No se ejecuta `cloudflared` desde ninguna de estas herramientas de NeuroTrace. Una dirección válida de túnel es suficiente para la configuración de la aplicación. Para reutilizar una red ya creada, conserva las credenciales del propietario o utiliza una invitación; conocer la URL no concede acceso administrativo. Para reclamar por MCP un servidor nuevo en la nube, `neurotrace_connect` acepta `server_url` y un `setup_key_file` privado, sin pegar secretos en el chat.
