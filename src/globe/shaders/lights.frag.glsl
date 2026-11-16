#version 300 es
  precision highp float;
  uniform sampler2D tex; uniform vec2 center, texSize; uniform float scale, cphi, sphi, lam, gain;
  uniform vec3 sun; uniform float useSun, H;
  out vec4 o;
  const float PI = 3.14159265359;
  // Catmull-Rom bicubic in 9 bilinear taps: smooth, sharp upscaling when zoomed in
  vec3 bicubic(vec2 uv) {
    vec2 sp = uv * texSize, tc = floor(sp - .5) + .5, f = sp - tc;
    vec2 w0 = f * (-.5 + f * (1. - .5 * f)), w1 = 1. + f * f * (-2.5 + 1.5 * f);
    vec2 w2 = f * (.5 + f * (2. - 1.5 * f)), w3 = f * f * (-.5 + .5 * f);
    vec2 w12 = w1 + w2, o12 = w2 / w12;
    vec2 t0 = (tc - 1.) / texSize, t3 = (tc + 2.) / texSize, t12 = (tc + o12) / texSize;
    vec3 r = vec3(0.);
    r += textureLod(tex, vec2(t0.x, t0.y), 0.).rgb * w0.x * w0.y;
    r += textureLod(tex, vec2(t12.x, t0.y), 0.).rgb * w12.x * w0.y;
    r += textureLod(tex, vec2(t3.x, t0.y), 0.).rgb * w3.x * w0.y;
    r += textureLod(tex, vec2(t0.x, t12.y), 0.).rgb * w0.x * w12.y;
    r += textureLod(tex, vec2(t12.x, t12.y), 0.).rgb * w12.x * w12.y;
    r += textureLod(tex, vec2(t3.x, t12.y), 0.).rgb * w3.x * w12.y;
    r += textureLod(tex, vec2(t0.x, t3.y), 0.).rgb * w0.x * w3.y;
    r += textureLod(tex, vec2(t12.x, t3.y), 0.).rgb * w12.x * w3.y;
    r += textureLod(tex, vec2(t3.x, t3.y), 0.).rgb * w3.x * w3.y;
    return max(r, 0.);
  }
  // how much of a pixel is artificial light (lamps are warm/white, moonlit terrain and ice are blue)
  float lightOf(vec3 c) { return clamp((c.r - .45 * c.b) / .55, 0., 1.); }
  void main(){
    vec2 px = vec2(gl_FragCoord.x, H - gl_FragCoord.y);
    float u = (px.x - center.x) / scale, v = -(px.y - center.y) / scale;
    float r2 = u*u + v*v;
    if (r2 > 1.) { o = vec4(0.,0.,0.,1.); return; }
    float w = sqrt(1. - r2);
    // invert d3 orthographic + rotate([lam, phi, 0])
    float lon = atan(u, w * cphi + v * sphi) - lam;
    float lat = asin(clamp(v * cphi - w * sphi, -1., 1.));
    vec2 uv = vec2(fract((lon + PI) / (2.*PI)), (PI*.5 - lat) / PI);
    vec2 dx = vec2(dFdx(lon), dFdx(lat)), dy = vec2(dFdy(lon), dFdy(lat));
    dx.x -= 2.*PI*floor(dx.x/(2.*PI) + .5); dy.x -= 2.*PI*floor(dy.x/(2.*PI) + .5);
    vec2 gx = vec2(dx.x/(2.*PI), -dx.y/PI), gy = vec2(dy.x/(2.*PI), -dy.y/PI);
    float fp = max(length(gx * texSize), length(gy * texSize));      // texels per screen pixel
    float lod = max(log2(max(fp, 1e-4)), 0.);
    vec3 c = fp < 1. ? bicubic(uv) : textureGrad(tex, uv, gx, gy).rgb;
    float L = lightOf(c);
    // terrain: faint moonlit land, kept dark so country colours show through
    vec3 terrain = c * .42 * (1. - smoothstep(.05, .3, L));
    // lamps: contrast curve + sodium/LED colour ramp, faint lights lifted so small towns show
    float core = pow(L, .8);
    float aa = max(fwidth(L), .02);
    float hot = smoothstep(.62 - aa, .62 + aa, L);
    vec3 lamp = mix(vec3(1., .62, .25), vec3(1., .86, .58), smoothstep(.2, .6, L));
    lamp = mix(lamp, vec3(1., .97, .9), hot) * core * 1.75;
    // bloom from blurred mip levels: the soft glow seen in night photos
    float b1 = lightOf(textureLod(tex, uv, lod + 1.5).rgb);
    float b2 = lightOf(textureLod(tex, uv, lod + 3.5).rgb);
    vec3 glow = vec3(1., .6, .25) * (b1 * .32 + b2 * .28);
    vec3 col = terrain + lamp + glow;
    float k = gain * smoothstep(0., .22, w);             // fade at the edge of the globe
    if (useSun > .5) {
      vec3 pt = vec3(cos(lat)*cos(lon), cos(lat)*sin(lon), sin(lat));
      k *= smoothstep(.02, -.12, dot(pt, sun));          // night side only, soft twilight
    }
    o = vec4(col * k, 1.);
  }
