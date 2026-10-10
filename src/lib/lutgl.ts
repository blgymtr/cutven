import { LUT_N } from './lumetri';

/**
 * Applies a baked 3D LUT with WebGL2 (hardware trilinear filtering on a float 3D texture),
 * matching ffmpeg lut3d:interp=trilinear. Returns a canvas with the graded image.
 */

let gl: WebGL2RenderingContext | null = null;
let cv: HTMLCanvasElement | null = null;
let prog: WebGLProgram | null = null;
let srcTex: WebGLTexture | null = null;
let lutTex: WebGLTexture | null = null;
let lutKey = '';
let failed = false;

const VS = `#version 300 es
in vec2 p; out vec2 uv;
void main(){ uv = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5); gl_Position = vec4(p, 0.0, 1.0); }`;
const FS = `#version 300 es
precision highp float; precision highp sampler3D;
in vec2 uv; out vec4 o;
uniform sampler2D img; uniform sampler3D lut; uniform float n;
void main(){
  vec4 c = texture(img, uv);
  vec3 rgb = c.a > 0.0 ? c.rgb / c.a : c.rgb;          // un-premultiply
  vec3 coord = (clamp(rgb, 0.0, 1.0) * (n - 1.0) + 0.5) / n;
  vec3 g = texture(lut, coord).rgb;
  o = vec4(g * c.a, c.a);
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
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    failed = true;
    gl = null;
    return null;
  }
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  srcTex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, srcTex);
  for (const [k, v] of [
    [gl.TEXTURE_MIN_FILTER, gl.NEAREST],
    [gl.TEXTURE_MAG_FILTER, gl.NEAREST],
    [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
    [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
  ])
    gl.texParameteri(gl.TEXTURE_2D, k, v);
  lutTex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_3D, lutTex);
  for (const [k, v] of [
    [gl.TEXTURE_MIN_FILTER, gl.LINEAR],
    [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
    [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
    [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
    [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE],
  ])
    gl.texParameteri(gl.TEXTURE_3D, k, v);
  gl.uniform1i(gl.getUniformLocation(prog, 'img'), 0);
  gl.uniform1i(gl.getUniformLocation(prog, 'lut'), 1);
  gl.uniform1f(gl.getUniformLocation(prog, 'n'), LUT_N);
  return gl;
}

export function applyLut(src: HTMLCanvasElement, key: string, data: Float32Array): HTMLCanvasElement {
  const g = init();
  if (!g || !cv) return src;
  if (cv.width !== src.width || cv.height !== src.height) {
    cv.width = src.width;
    cv.height = src.height;
  }
  g.viewport(0, 0, src.width, src.height);
  if (key !== lutKey) {
    // RGB32F → RGBA16F upload (16F is filterable everywhere)
    const n = LUT_N;
    const rgba = new Float32Array(n * n * n * 4);
    for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
      rgba[j] = data[i];
      rgba[j + 1] = data[i + 1];
      rgba[j + 2] = data[i + 2];
      rgba[j + 3] = 1;
    }
    g.activeTexture(g.TEXTURE1);
    g.bindTexture(g.TEXTURE_3D, lutTex);
    g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    g.texImage3D(g.TEXTURE_3D, 0, g.RGBA16F, n, n, n, 0, g.RGBA, g.FLOAT, rgba);
    lutKey = key;
  }
  g.activeTexture(g.TEXTURE0);
  g.bindTexture(g.TEXTURE_2D, srcTex);
  g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, src);
  g.clearColor(0, 0, 0, 0);
  g.clear(g.COLOR_BUFFER_BIT);
  g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
  return cv;
}
