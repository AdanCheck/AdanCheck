# Lecturas Pintolindo

App web para leer artículos con la cámara del celular y controlar los traslados entre depósitos. Funciona sin conexión y genera reportes en Excel y PDF.

## Publicarla en GitHub Pages

1. Creá una cuenta en github.com (si no tenés) y un repositorio nuevo, por ejemplo `lecturas-pintolindo`. Con la cuenta gratuita, el repositorio tiene que ser público.
2. En el repositorio, tocá **Add file > Upload files** y subí todo el contenido de esta carpeta (todos los archivos van sueltos en la raíz del repositorio, sin carpetas). Confirmá con **Commit changes**.
3. Andá a **Settings > Pages**. En **Source** elegí **Deploy from a branch**, rama `main`, carpeta `/ (root)`, y guardá.
4. Al minuto la app queda en `https://TU-USUARIO.github.io/lecturas-pintolindo/`.

No subas el catálogo al repositorio: se importa desde cada teléfono (ver más abajo). Así no queda publicado en internet.

## Instalarla en el celular

Abrí la dirección en el teléfono:

- **Android (Chrome):** menú de los tres puntos > **Agregar a la pantalla principal** o **Instalar app**.
- **iPhone (Safari):** botón de compartir > **Agregar a inicio**.

La primera vez que enciendas la cámara, el navegador pide permiso. Aceptalo.

## Primera configuración (en cada teléfono)

1. **Ajustes > Depósitos:** cargá los depósitos.
2. **Ajustes > Responsables:** cargá las personas que hacen las lecturas.
3. **Ajustes > Catálogo:** importá el archivo CSV o Excel exportado del sistema de gestión. La app detecta las columnas y te deja corregirlas. Solo usa código interno, código de barras y descripción; si el archivo trae precios o costos, se ignoran.
4. Para pasar todo a otro teléfono: **Descargar copia** en el primero y **Restaurar copia** en el otro.

### Formato del catálogo

Primera fila con encabezados. Separador `;` o `,`. Ejemplo en `plantilla_catalogo.csv`:

```
codigo;codigo_barras;descripcion
ART-0001;7790000000017;Látex interior blanco 20 L
```

Si un artículo tiene varios códigos de barras, se pueden poner en la misma celda separados por espacio o `/`. Los artículos sin código de barras se agregan buscándolos por descripción.

**Importante:** el código interno tiene que ser exactamente el mismo que usa el sistema de gestión; si no, el cruce de los reportes no va a coincidir.

## Uso diario

1. **Lectura:** elegí el tipo de movimiento (salida por traslado, recepción de traslado o inventario), los depósitos, el responsable y, si querés, el número de remito.
2. Encendé la cámara y escaneá. Cada lectura suma la cantidad indicada (por defecto 1). Para sumar varias unidades de una vez, subí la cantidad antes de escanear.
3. Si un código no está en el catálogo, se registra igual marcado en rojo como no catalogado.
4. **Finalizar lectura** y exportá en Excel o PDF desde el detalle.
5. **Historial:** filtrá por fecha y hora, depósito, responsable o tipo y exportá todo junto.

El Excel trae las hojas **Detalle** (una fila por artículo), **Lecturas** (una fila por lectura) y, si exportás varias, **Totales por artículo**.

## Cuidado con los datos

Las lecturas se guardan solo en el teléfono donde se hicieron. Si se borran los datos del navegador, se pierden. Descargá una copia de seguridad seguido.

## Actualizar la app

Reemplazá `index.html` en GitHub. Los teléfonos toman la versión nueva la próxima vez que abran la app con conexión. Si cambiás alguna librería o ícono, cambiá también `VERSION` en `sw.js` (por ejemplo, de `v1` a `v2`).
