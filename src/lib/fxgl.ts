/**
 * Tiny WebGL helper for the lens (fisheye) effect in the preview.
 * The math matches ffmpeg's lenscorrection: src = c + off·(1 + k1·r² + k2·r⁴),
 * with r² = |off|² / ((w² + h²) / 4); unmapped pixels are transparent.
 */

let gl: WebGLRenderingContext | null = null;
let glCanvas: HTMLCanvasElement | null = null;
let prog: WebGLProgram | null = null;
let tex: WebGLTexture | null = null;
let loc: Record<string, WebGLUniformLocation | null> = {};

const VS = `attribute vec2 p; varying vec2 uv; void main(){ uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;
const FS = `precision highp float;
varying vec2 uv;
uniform sampler2D img;
uniform vec2 size;
uniform float k1;
uniform float k2;
void main(){
  vec2 px = vec2(uv.x, 1.0 - uv.y) * size;
  vec2 c = size * 0.5;
  vec2 off = px - c;
  float r2 = dot(off, off) / ((size.x * size.x + size.y * size.y) / 4.0);
  vec2 src = c + off * (1.0 + k1 * r2 + k2 * r2 * r2);
  if (src.x < 0.0 || src.y < 0.0 || src.x > size.x || src.y > size.y) { gl_FragColor = vec4(0.0); return; }
  gl_FragColor = texture2D(img, src / size);
}`;

function init() {
  if (gl) return gl;
  glCanvas = document.createElement('canvas');
  gl = glCanvas.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true });
  if (!gl) return null;
  const sh = (type: number, src: string) => {
    const s = gl!.createShader(type)!;
    gl!.shaderSource(s, src);
    gl!.compileShader(s);
    return s;
  };
  prog = gl.createProgram()!;
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const p = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(p);
  gl.vertexAttribPointer(p, 2, gl.FLOAT, false, 0, 0);
  tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  loc = { size: gl.getUniformLocation(prog, 'size'), k1: gl.getUniformLocation(prog, 'k1'), k2: gl.getUniformLocation(prog, 'k2') };
  return gl;
}

/** Returns a canvas with the lens-distorted image (or the input if WebGL is unavailable). */
export function fisheye(src: HTMLCanvasElement, k1: number, k2: number): HTMLCanvasElement {
  const g = init();
  if (!g || !glCanvas) return src;
  if (glCanvas.width !== src.width || glCanvas.height !== src.height) {
    glCanvas.width = src.width;
    glCanvas.height = src.height;
  }
  g.viewport(0, 0, src.width, src.height);
  g.bindTexture(g.TEXTURE_2D, tex);
  g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, false);
  g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, src);
  g.uniform2f(loc.size, src.width, src.height);
  g.uniform1f(loc.k1, k1);
  g.uniform1f(loc.k2, k2);
  g.clearColor(0, 0, 0, 0);
  g.clear(g.COLOR_BUFFER_BIT);
  g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
  return glCanvas;
}
