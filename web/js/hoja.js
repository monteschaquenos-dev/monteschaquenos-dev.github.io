// Detector de la hoja en una foto y mejora para leer facturas.
// Lo usan la cámara del bot (web/escanear.html, en el teléfono) y el bot (lib/imagen.js) antes de leer con la IA.
// Trabaja con imágenes en crudo: { width, height, data } con 4 bytes por píxel (RGBA), como canvas y jpeg-js.
(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) module.exports = fabrica();
  else raiz.Hoja = fabrica();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Gris chico (ancho máx. `ancho`) para analizar rápido
  function grisChico(img, ancho) {
    const esc = Math.min(1, ancho / img.width);
    const w = Math.max(1, Math.round(img.width * esc));
    const h = Math.max(1, Math.round(img.height * esc));
    const g = new Uint8Array(w * h);
    const fx = img.width / w;
    const fy = img.height / h;
    for (let y = 0; y < h; y++) {
      const sy = Math.min(img.height - 1, Math.floor((y + 0.5) * fy));
      for (let x = 0; x < w; x++) {
        const sx = Math.min(img.width - 1, Math.floor((x + 0.5) * fx));
        const i = (sy * img.width + sx) * 4;
        g[y * w + x] = (img.data[i] * 299 + img.data[i + 1] * 587 + img.data[i + 2] * 114) / 1000;
      }
    }
    return { w, h, g };
  }

  // Umbral de Otsu (separa la hoja clara del fondo)
  function otsu(g) {
    const hist = new Array(256).fill(0);
    for (let i = 0; i < g.length; i++) hist[g[i]]++;
    let suma = 0;
    for (let i = 0; i < 256; i++) suma += i * hist[i];
    let sumB = 0, wB = 0, mejor = 0, umbral = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      const wF = g.length - wB;
      if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (suma - sumB) / wF;
      const v = wB * wF * (mB - mF) * (mB - mF);
      if (v > mejor) { mejor = v; umbral = t; }
    }
    return umbral;
  }

  // Busca la hoja: la mancha clara más grande. Devuelve el recuadro en proporciones (0 a 1) y datos para guiar:
  // cobertura (cuánto de la foto ocupa), nitidez (0 a 1), luz (0 a 255), y si conviene recortar.
  function detectar(img) {
    const { w, h, g } = grisChico(img, 240);
    const t = otsu(g);
    const claro = new Uint8Array(w * h);
    for (let i = 0; i < g.length; i++) claro[i] = g[i] > t ? 1 : 0;
    // Componente conexa clara más grande
    const visto = new Uint8Array(w * h);
    const pila = new Int32Array(w * h);
    let mejor = null;
    for (let i0 = 0; i0 < w * h; i0++) {
      if (!claro[i0] || visto[i0]) continue;
      let n = 0, x0 = w, y0 = h, x1 = 0, y1 = 0, tope = 0;
      pila[tope++] = i0; visto[i0] = 1;
      while (tope) {
        const i = pila[--tope];
        const x = i % w, y = (i / w) | 0;
        n++;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x > 0 && claro[i - 1] && !visto[i - 1]) { visto[i - 1] = 1; pila[tope++] = i - 1; }
        if (x < w - 1 && claro[i + 1] && !visto[i + 1]) { visto[i + 1] = 1; pila[tope++] = i + 1; }
        if (y > 0 && claro[i - w] && !visto[i - w]) { visto[i - w] = 1; pila[tope++] = i - w; }
        if (y < h - 1 && claro[i + w] && !visto[i + w]) { visto[i + w] = 1; pila[tope++] = i + w; }
      }
      if (!mejor || n > mejor.n) mejor = { n, x0, y0, x1, y1 };
    }
    if (!mejor) return { hoja: null, cobertura: 0, nitidez: 0, luz: 0, recortar: false };
    const bw = mejor.x1 - mejor.x0 + 1, bh = mejor.y1 - mejor.y0 + 1;
    const cobertura = (bw * bh) / (w * h);
    const relleno = mejor.n / (bw * bh); // una hoja es un rectángulo bastante lleno
    // Luz y nitidez dentro de la hoja (la letra impresa da bordes fuertes si no está movida)
    let sumaLuz = 0, cant = 0, lap = 0, lapN = 0;
    for (let y = Math.max(1, mejor.y0); y <= Math.min(h - 2, mejor.y1); y++) {
      for (let x = Math.max(1, mejor.x0); x <= Math.min(w - 2, mejor.x1); x++) {
        const i = y * w + x;
        sumaLuz += g[i]; cant++;
        const l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
        lap += l * l; lapN++;
      }
    }
    const luz = cant ? sumaLuz / cant : 0;
    const nitidez = lapN ? Math.min(1, Math.sqrt(lap / lapN) / 40) : 0;
    const esHoja = cobertura > 0.08 && relleno > 0.55;
    const hoja = esHoja ? { x: mejor.x0 / w, y: mejor.y0 / h, w: bw / w, h: bh / h } : null;
    return { hoja, cobertura: esHoja ? cobertura : 0, nitidez, luz, recortar: esHoja && cobertura < 0.85 };
  }

  // Qué decirle a Víctor mientras apunta la cámara (y si ya se puede sacar sola)
  function consejo(d) {
    if (!d.hoja) return { texto: 'Apuntá a la factura sobre una mesa oscura', ok: false };
    if (d.luz < 110) return { texto: 'Falta luz', ok: false };
    if (d.cobertura < 0.45) return { texto: 'Acercate más a la hoja', ok: false };
    if (d.nitidez < 0.18) return { texto: 'Quieto… se ve movida', ok: false };
    return { texto: '¡Bien! No te muevas', ok: true };
  }

  // Recorta [x, y, w, h] en proporciones, con un margen chico
  function recortar(img, caja, margen) {
    const m = margen == null ? 0.015 : margen;
    const x0 = Math.max(0, Math.floor((caja.x - m) * img.width));
    const y0 = Math.max(0, Math.floor((caja.y - m) * img.height));
    const x1 = Math.min(img.width, Math.ceil((caja.x + caja.w + m) * img.width));
    const y1 = Math.min(img.height, Math.ceil((caja.y + caja.h + m) * img.height));
    const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      const ini = ((y0 + y) * img.width + x0) * 4;
      data.set(img.data.subarray(ini, ini + w * 4), y * w * 4);
    }
    return { width: w, height: h, data };
  }

  // Escala con interpolación bilineal hasta que el lado largo mida `lado` (agranda hasta 2 veces como mucho)
  function escalar(img, lado) {
    const f = Math.min(2, lado / Math.max(img.width, img.height));
    if (Math.abs(f - 1) < 0.05) return img;
    const w = Math.max(1, Math.round(img.width * f)), h = Math.max(1, Math.round(img.height * f));
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      const sy = Math.min(img.height - 1, (y + 0.5) / f - 0.5);
      const ya = Math.max(0, Math.floor(sy)), yb = Math.min(img.height - 1, ya + 1), dy = Math.max(0, sy - ya);
      for (let x = 0; x < w; x++) {
        const sx = Math.min(img.width - 1, (x + 0.5) / f - 0.5);
        const xa = Math.max(0, Math.floor(sx)), xb = Math.min(img.width - 1, xa + 1), dx = Math.max(0, sx - xa);
        const a = (ya * img.width + xa) * 4, b = (ya * img.width + xb) * 4, c = (yb * img.width + xa) * 4, d = (yb * img.width + xb) * 4;
        const o = (y * w + x) * 4;
        for (let k = 0; k < 3; k++) {
          data[o + k] = (img.data[a + k] * (1 - dx) + img.data[b + k] * dx) * (1 - dy) + (img.data[c + k] * (1 - dx) + img.data[d + k] * dx) * dy;
        }
        data[o + 3] = 255;
      }
    }
    return { width: w, height: h, data };
  }

  // Blanco y negro con contraste estirado (la letra queda bien negra y el papel blanco)
  function mejorar(img) {
    const n = img.width * img.height;
    const gris = new Uint8Array(n);
    const hist = new Array(256).fill(0);
    for (let i = 0; i < n; i++) {
      const j = i * 4;
      const v = (img.data[j] * 299 + img.data[j + 1] * 587 + img.data[j + 2] * 114) / 1000;
      gris[i] = v; hist[gris[i]]++;
    }
    const corte = p => { let acum = 0; for (let v = 0; v < 256; v++) { acum += hist[v]; if (acum >= n * p) return v; } return 255; };
    const lo = corte(0.01), hi = Math.max(lo + 30, corte(0.97));
    const data = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
      const v = Math.max(0, Math.min(255, ((gris[i] - lo) * 255) / (hi - lo)));
      const j = i * 4;
      data[j] = data[j + 1] = data[j + 2] = v; data[j + 3] = 255;
    }
    return { width: img.width, height: img.height, data };
  }

  // Partes horizontales que se pisan un poco (para leer de a pedazos cuando la tabla es larga o la letra chica)
  function partes(img, n, solape) {
    const s = solape == null ? 0.08 : solape;
    const res = [];
    for (let k = 0; k < n; k++) {
      const y = Math.max(0, k / n - s), y2 = Math.min(1, (k + 1) / n + s);
      res.push(recortar(img, { x: 0, y, w: 1, h: y2 - y }, 0));
    }
    return res;
  }

  // Todo junto: busca la hoja, la recorta, la agranda y la mejora
  function prepararParaLeer(img, lado) {
    const d = detectar(img);
    let r = d.recortar ? recortar(img, d.hoja) : img;
    r = escalar(r, lado || 2000);
    return { imagen: mejorar(r), recortada: d.recortar, deteccion: d };
  }

  return { detectar, consejo, recortar, escalar, mejorar, partes, prepararParaLeer, otsu };
});
