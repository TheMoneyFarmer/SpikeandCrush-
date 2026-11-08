three-lite.min.js is three@0.187.0 (MIT, see LICENSE), trimmed to what
client/js/card-showcase.js uses and minified with esbuild 0.25. To add a class,
add it to the export list below and rebuild:

    export { Scene, PerspectiveCamera, WebGLRenderer, Mesh, Group, Shape, ShapeGeometry, ExtrudeGeometry, BoxGeometry, MeshPhysicalMaterial, MeshStandardMaterial, MeshBasicMaterial, CanvasTexture, DirectionalLight, HemisphereLight, PMREMGenerator, Color, SRGBColorSpace } from 'three/build/three.module.js';

    esbuild entry.js --bundle --minify --format=esm --target=es2020 \
      --legal-comments=none --outfile=three-lite.min.js
