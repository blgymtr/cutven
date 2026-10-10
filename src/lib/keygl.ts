/**
 * Chroma key (green / blue screen) for the preview, mirroring ffmpeg:
 *  chromakey: BT.601 (CCIR) U/V distance to the key colour,
 *             alpha = clip((diff - similarity) / blend, 0, 1)
 *  despill:   spill = max(G - (R·mix + B·(1-mix)), 0); G -= amount·spill  (blue screens swap G/B)
 */

let gl: WebGL2RenderingContext | null = null;
let cv: HTMLCanvasElement | null = null;
let prog: WebGLProgram | null = null;
let tex: WebGLTexture | null = null;
let U: Record<string, WebGLUniformLocation | null> = {};
let failed = false;

const VS = `#version 300 es
in vec2 p; out vec2 uv;
void main(){ uv = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5); gl_Position = vec4(p, 0.0, 1.0); }`;
const FS = `#version 300 es
precision highp float;
in vec2 uv; out vec4 o;
uniform sampler2D img; uniform vec2 key; uniform float sim; uniform float blend; uniform float spill; uniform float blue;
vec2 uvOf(vec3 c){ c *= 255.0; return vec2(-0.148*c.r - 0.291*c.g + 0.439*c.b, 0.439*c.r - 0.368*c.g - 0.071*c.b); }
void main(){
  vec4 s = texture(img, uv);
  vec3 c = s.a > 0.0 ? s.rgb / s.a : s.rgb;
  vec2 d = uvOf(c) - key;
  float diff = sqrt((d.x*d.x + d.y*d.y) / (255.0*255.0*2.0));
  float a = blend > 0.0001 ? clamp((diff - sim) / blend, 0.0, 1.0) : (diff > sim ? 1.0 : 0.0);
  if (spill > 0.0) {
    if (blue > 0.5) { float m = max(c.b - (c.r*0.5 + c.g*0.5), 0.0); c.b = max(c.b - spill*m, 0.0); }
    else { float m = max(c.g - (c.r*0.5 + c.b*0.5), 0.0); c.g = max(c.g - spill*m, 0.0); }
  }
  float oa = s.a * a;
  o = vec4(c * oa, oa);
}`;

function init() {
  if (gl || failed) return gl;
  cv = document.createElement('canvas');
  gl = cv.getContext('webgl2', { premultipliedAlpha: true, preserveDrawingBuffer: true });
  if (!gl) {
    failed = true;
    return null;
  }
  const sh = (t: number, s: string) => {
    const x = gl!.createShader(t)!;
    gl!.shaderSource(x, s);
    gl!.compileShader(x);
    return x;
  };
  prog = gl.createProgram()!;
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  for (const k of ['img', 'key', 'sim', 'blend', 'spill', 'blue']) U[k] = gl.getUniformLocation(prog, k);
  gl.uniform1i(U.img, 0);
  return gl;
}

export const hexRgb = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '');
  const v = parseInt(h.length === 3 ? h.split('').map((x) => x + x).join('') : h, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};

/** U/V of the key colour exactly as ffmpeg's RGB_TO_U_CCIR / RGB_TO_V_CCIR (minus the 128 offset). */
export function keyUV(hex: string): [number, number] {
  const [r, g, b] = hexRgb(hex);
  const u = ((-38 * r - 74 * g + 112 * b + 128) >> 8);
  const v = ((112 * r - 94 * g - 18 * b + 128) >> 8);
  return [u, v];
}

export function chromaKey(src: HTMLCanvasElement, color: string, similarity: number, smooth: number, spill: number): HTMLCanvasElement {
  const g = init();
  if (!g || !cv) return src;
  if (cv.width !== src.width || cv.height !== src.height) {
    cv.width = src.width;
    cv.height = src.height;
  }
  g.viewport(0, 0, src.width, src.height);
  g.useProgram(prog);
  g.bindTexture(g.TEXTURE_2D, tex);
  g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, src);
  const [u, v] = keyUV(color);
  const [r, gg, b] = hexRgb(color);
  g.uniform2f(U.key, u, v);
  g.uniform1f(U.sim, similarity);
  g.uniform1f(U.blend, smooth);
  g.uniform1f(U.spill, spill);
  g.uniform1f(U.blue, b > gg && b > r ? 1 : 0);
  g.clearColor(0, 0, 0, 0);
  g.clear(g.COLOR_BUFFER_BIT);
  g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
  return cv;
}
