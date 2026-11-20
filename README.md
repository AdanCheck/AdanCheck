# Lecturas Pintolindo (versión con Railway)

App para leer artículos con la cámara del celular y controlar los traslados entre depósitos. Los datos (usuarios, depósitos, catálogo y lecturas) se guardan en una base de datos en Railway, así que se ven igual desde cualquier teléfono o computadora.

## Archivos del repositorio

Todos van sueltos en la raíz, sin carpetas:

- Servidor: `server.js`, `package.json`, `package-lock.json`
- App: `index.html`, `sw.js`, `manifest.webmanifest`
- Librerías: `html5-qrcode.min.js`, `xlsx.full.min.js`, `jspdf.umd.min.js`, `jspdf.plugin.autotable.min.js`
- Íconos: `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`
- Plantilla: `plantilla_catalogo.csv`

No hay contraseñas en estos archivos: las claves van en las variables de Railway.

## Publicar en Railway

1. En railway.com, **New Project > Deploy from GitHub repo** y elegí este repositorio.
2. En el mismo proyecto, **Create > Database > PostgreSQL**.
3. Abrí el servicio de la app (no el de la base) > **Variables** y agregá:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `SESSION_SECRET` = una frase larga e inventada, de 30 caracteres o más
   - `ADMIN_PIN` = el PIN del administrador, de 4 a 8 números
4. En el servicio de la app > **Settings > Networking > Generate Domain**. Esa es la dirección de la app.
5. Abrí la dirección e ingresá con el nombre **Administrador** y el `ADMIN_PIN`.

Cada vez que subas cambios al repositorio de GitHub, Railway vuelve a publicar la app solo.

## Primera configuración (una sola vez, desde cualquier dispositivo)

En **Ajustes**, con el usuario Administrador:

1. **Usuarios:** agregá a cada persona con un PIN. Conviene crear también tu propio usuario como administrador.
2. **Depósitos:** cargalos.
3. **Catálogo:** importá el CSV o Excel. Queda disponible en todos los teléfonos.
4. Si usaste la versión de GitHub Pages: ahí, **Ajustes > Descargar copia**, y acá **Traer datos de la versión anterior**.

## Uso

- Cada persona ingresa con su nombre y su PIN. Las lecturas quedan a su nombre.
- Si no hay señal, la app sigue funcionando: las lecturas se guardan en el teléfono y se suben solas cuando vuelve la conexión. Arriba aparece un aviso mientras haya lecturas sin subir.
- El historial y los reportes muestran las lecturas de todos los teléfonos.
- Los operadores pueden hacer lecturas y ver o exportar el historial. Solo los administradores cambian el catálogo, los depósitos y los usuarios, y pueden eliminar lecturas de otros.

## Control de traslados

1. En el depósito de origen, se hace una **Salida por traslado** hacia el depósito de destino.
2. Al llegar, se hace una **Recepción de traslado**: después de elegir el depósito de destino, la app muestra las salidas pendientes hacia ese depósito. Se marcan una o varias, las que lleguen en ese viaje.
3. Se escanea lo que llegó, sin ver lo que se envió.
4. Al finalizar, el detalle de la recepción muestra la comparación: enviado, recibido, diferencia y estado (faltante, sobrante, no enviado u OK). Se exporta en Excel o PDF con **Excel del control** y **PDF del control**.

En el **Historial**, las salidas muestran si están pendientes de recepción, recibidas OK o recibidas con diferencias, y se pueden filtrar por ese estado.

## Si el administrador olvida su PIN

En Railway, cambiá `ADMIN_PIN` por un PIN nuevo y agregá la variable `RESET_ADMIN_PIN` = `si`. Cuando la app se reinicie, ingresá con el PIN nuevo y después borrá `RESET_ADMIN_PIN`.

## Formato del catálogo

```
codigo;codigo_barras;descripcion
ART-0001;7790000000017;Látex interior blanco 20 L
ART-0003;;Rodillo antigota 23 cm
```

El código interno tiene que ser igual al del sistema de gestión. Si un artículo no tiene código de barras, se puede escanear una etiqueta con su código interno o buscarlo por descripción.
