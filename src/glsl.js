"use strict";
/* =======================================================================================
   D33 LUNAR CARGO MISSION v7 — SHARED GLSL BLOCKS
   Colour pipeline: linear HDR everywhere, AgX output transform applied ONCE in the post
   pass (or inline via outc() when the float render target is unavailable). Never
   re-encode sRGB after agxEotf().
   ======================================================================================= */
var GL_COMMON = {};

/* ---- hash / value noise / fbm ---- */
GL_COMMON.NOISE = `
/* Integer hash — bit-identical to the JS twin in core.js, so GPU terrain displacement and
   CPU vehicle placement agree exactly. A sin()-based hash diverges at these world
   coordinates because the argument exceeds float32 precision. */
uint hashU(ivec2 p){ uint x=uint(p.x), y=uint(p.y);
  uint h = x*374761393u + y*668265263u;
  h = (h ^ (h>>13u)) * 1274126177u;
  return h ^ (h>>16u); }
float h21i(int x,int y){ return float(hashU(ivec2(x,y)))*(1.0/4294967296.0); }
float vn2(vec2 x){ vec2 fl=floor(x); ivec2 i=ivec2(fl); vec2 f=x-fl;
  f=f*f*(3.0-2.0*f);
  float a=h21i(i.x,i.y), b=h21i(i.x+1,i.y), c=h21i(i.x,i.y+1), d=h21i(i.x+1,i.y+1);
  return a+(b-a)*f.x+(c-a)*f.y+(a-b-c+d)*f.x*f.y; }
float h21(vec2 p){ return vn2(p); }
/* Each octave is rotated by an irrational-ish angle. Plain value noise on an axis-aligned
   lattice reads as a visible grid across the surface; rotating between octaves breaks the
   alignment up and is what makes it look like regolith rather than graph paper. */
const mat2 ROT=mat2(0.8018,-0.5976,0.5976,0.8018);
float fb2(vec2 p,int oct){ float v=0.0,a=0.5; for(int i=0;i<8;i++){ if(i>=oct) break;
  v+=a*vn2(p); a*=0.5; p=ROT*p*2.03; } return v; }
/* Isotropic single-scale detail: three rotated taps, no dominant axis. */
float dtl(vec2 p){ return (vn2(p)+vn2(ROT*p*1.93+19.3)+vn2(ROT*ROT*p*3.71+7.7))*0.3333; }
`;

/* ---- AgX (house default output transform) ----
   Community minimal fit; agxEotf() already display-encodes. */
GL_COMMON.AGX = `
vec3 agxContrast(vec3 x){ vec3 x2=x*x, x4=x2*x2;
  return 15.5*x4*x2 - 40.14*x4*x + 31.96*x4 - 6.868*x2*x + 0.4298*x2 + 0.1191*x - 0.00232; }
vec3 agx(vec3 c){
  const mat3 M = mat3(0.8424790,0.0423282,0.0423757, 0.0784336,0.8784686,0.0784336,
                      0.0792237,0.0791661,0.8791430);
  const float lo=-12.47393, hi=4.026069;
  c = M*c; c = clamp(log2(max(c,1e-10)), lo, hi); c = (c-lo)/(hi-lo);
  return agxContrast(c); }
vec3 agxEotf(vec3 c){
  const mat3 Mi = mat3( 1.1968790,-0.0528969,-0.0529716, -0.0980209, 1.1519031,-0.0980435,
                       -0.0990297,-0.0989612, 1.1510737);
  return pow(max(Mi*c,0.0), vec3(2.2)); }
vec3 agxLook(vec3 c){                       /* gentle contrast + slight desaturation */
  float l=dot(c,vec3(0.2126,0.7152,0.0722));
  return mix(vec3(l),c,1.02); }
uniform int uPost; uniform float uEV;
vec4 outc(vec3 hdr){
  if(uPost==1) return vec4(hdr,1.0);        /* post pass tonemaps later */
  return vec4(agxEotf(agxLook(agx(max(hdr,0.0)*exp2(uEV)))),1.0); }
`;

/* ---- vision modes (night vision / thermal) ---- */
GL_COMMON.VISION = `
/* Map kelvin to the palette with the cold end expanded. A linear 30-280 K ramp puts an
   entire permanently shadowed crater (35-45 K) in the bottom 4% of the scale, where it is
   indistinguishable from black — which defeats the point of the thermal view. */
float thermT(float K){ return pow(clamp((K-25.0)/235.0,0.0,1.0),0.45); }
vec3 thermPal(float t){ t=clamp(t,0.0,1.0);
  vec3 c1=vec3(0.02,0.01,0.10),c2=vec3(0.25,0.02,0.52),c3=vec3(0.85,0.12,0.15),
       c4=vec3(1.0,0.58,0.06),c5=vec3(1.0,0.97,0.80);
  if(t<0.25) return mix(c1,c2,t/0.25);
  if(t<0.55) return mix(c2,c3,(t-0.25)/0.30);
  if(t<0.82) return mix(c3,c4,(t-0.55)/0.27);
  return mix(c4,c5,(t-0.82)/0.18); }
vec3 nvMap(vec3 c, vec2 fc, float t){ float l=dot(c,vec3(0.30,0.55,0.15));
  l=1.0-exp(-l*260.0); float g=(h21(fc*0.7+vec2(t*57.0,t*23.0))-0.5)*0.11;
  float vg=1.0-0.5*pow(length(fc)*0.0007,2.0);
  return vec3(0.03,l*vg+g*0.5,0.06+l*0.10); }
`;

/* ---- lunar regolith BRDF ----
   FACT: regolith is strongly backscattering and NOT Lambertian. Lommel-Seeliger captures
   the single-scattering limb behaviour (radiance ~ mu0/(mu0+mu)); the Hapke opposition
   surge B(g) = B0/(1 + tan(g/2)/hh) reproduces the sharp brightening at zero phase.
   Normalised so mu0 == mu returns the plain albedo. */
GL_COMMON.REGOLITH = `
float oppositionSurge(float cosg, float B0, float hh){
  float g=acos(clamp(cosg,-1.0,1.0));
  return B0/(1.0+tan(min(g,1.5)*0.5)/hh); }
vec3 regolith(vec3 alb, vec3 N, vec3 L, vec3 V, float irr){
  float mu0=max(dot(N,L),0.0), mu=max(dot(N,V),0.0);
  if(mu0<=0.0) return vec3(0.0);
  float ls=2.0*mu0/max(mu0+mu,1e-3);
  float B=1.0+oppositionSurge(dot(L,V),0.85,0.06);
  return alb*ls*B*irr*mu0; }
`;

/* ---- lighting helpers: spot lamps + floodlight (linear falloff, vacuum: no scattering) ---- */
GL_COMMON.LAMPS = `
uniform float uLampOn; uniform vec3 uLp0,uLd0,uLp1,uLd1; uniform vec4 uFlood;
uniform float uLampI;
vec3 lampIrradiance(vec3 P, vec3 N){
  vec3 acc=vec3(0.0);
  for(int i=0;i<2;i++){
    vec3 lp=(i==0)?uLp0:uLp1, ld=(i==0)?uLd0:uLd1;
    vec3 d=P-lp; float dist=max(length(d),0.05); d/=dist;
    float cone=smoothstep(0.80,0.94,dot(d,ld));
    float att=uLampI/(dist*dist);
    acc+=vec3(1.0,0.94,0.78)*cone*att*max(dot(N,-d),0.0)*uLampOn; }
  vec3 fd=P-uFlood.xyz; float fl=max(length(fd),0.1);
  acc+=vec3(0.95,0.96,1.0)*(uFlood.w/(fl*fl))*max(dot(N,normalize(-fd)),0.0);
  return acc; }
`;

/* ---- object shadow map (sun-aligned ortho, PCF) ----
   Terrain self-shadowing comes from the DEM sun-visibility raster instead; this map only
   carries lander/rover/base casters, which is why a single low-res map is enough. */
GL_COMMON.SHADOW = `
uniform mat4 uShadowVP; uniform sampler2D uShadowTex; uniform float uShadowOn, uShadowTexel;
float objectShadow(vec3 P, vec3 N, vec3 L){
  if(uShadowOn<0.5) return 1.0;
  vec3 Pb = P + N*0.06 + L*0.10;              /* normal + light offset: grazing sun */
  vec4 sp = uShadowVP*vec4(Pb,1.0);
  vec3 uv = sp.xyz/sp.w*0.5+0.5;
  if(uv.x<0.002||uv.x>0.998||uv.y<0.002||uv.y>0.998||uv.z>1.0) return 1.0;
  float s=0.0;
  for(int y=-1;y<=1;y++) for(int x=-1;x<=1;x++){
    float d=texture(uShadowTex,uv.xy+vec2(float(x),float(y))*uShadowTexel).r;
    s += (uv.z-0.0022 > d) ? 0.0 : 1.0; }
  return s/9.0; }
`;

/* ---- DEM sampling: manual bilinear on an R32F texture (needs no float-filter extension) ----
   uDemA/uDemB map world XZ -> texel coordinates. Outside the DEM the fetch clamps, so the
   procedural skirt can blend against a continuous edge value. */
GL_COMMON.DEM = `
uniform sampler2D uDem;       /* R32F elevation, pad-relative metres */
uniform sampler2D uAux;       /* RG8: r = sun visibility (directional), g = mean illumination */
uniform vec2 uDemA, uDemB;    /* texel = world*uDemA + uDemB */
uniform float uDemN;
float demTexel(ivec2 c){
  c = clamp(c, ivec2(0), ivec2(int(uDemN)-1));
  return texelFetch(uDem,c,0).r; }
float demH(vec2 w){
  vec2 t = w*uDemA + uDemB - 0.5;
  vec2 f = fract(t); ivec2 i = ivec2(floor(t));
  float a=demTexel(i), b=demTexel(i+ivec2(1,0)), c=demTexel(i+ivec2(0,1)), d=demTexel(i+ivec2(1,1));
  return mix(mix(a,b,f.x),mix(c,d,f.x),f.y); }
float demInside(vec2 w){      /* 1 well inside the DEM, 0 outside, soft over one margin */
  vec2 t = w*uDemA + uDemB;
  vec2 e = min(t, uDemN-t);
  return smoothstep(2.0, 26.0, min(e.x,e.y)); }
vec2 auxAt(vec2 w){ return texture(uAux, (w*uDemA+uDemB)/uDemN).rg; }
`;

/* ---- terrain height field (shared by vertex displacement and normal FD) ----
   MEASURED: demH() inside the LOLA window.
   SYNTHETIC (cosmetic): procedural regolith beyond the window, sub-grid roughness and the
   small-crater field. Excluded from every screening number in the core. */
GL_COMMON.TERRAIN_H = `
uniform float uDetailR;       /* radius over which sub-grid detail is displaced */
uniform vec2  uAnchor;
uniform float uApron0, uApron1;
uniform float uBlastR;        /* scoured radius under the lander */
/* Mirrors craterCell() in core.js exactly — same hash, same constants. */
float craterField(vec2 w, float cell, float rMin, float rMax, float dD, int seed){
  vec2 g=floor(w/cell); int gx=int(g.x), gz=int(g.y); float h=0.0;
  for(int dz=-1;dz<=1;dz++) for(int dx=-1;dx<=1;dx++){
    int cx=gx+dx, cz=gz+dz;
    if(h21i(cx*3+seed, cz*5+seed)>0.42) continue;
    float px=(float(cx)+0.2+0.6*h21i(cx+13+seed,cz+41+seed))*cell;
    float pz=(float(cz)+0.2+0.6*h21i(cx+71+seed,cz+29+seed))*cell;
    float t=h21i(cx*7+seed+2, cz*11+seed+2);
    float r=rMin+(rMax-rMin)*t*t;
    float d=length(w-vec2(px,pz))/r; if(d>1.7) continue;
    float dep=dD*2.0*r;
    if(d<1.0) h+=dep*(d*d-1.0);
    float e=(d-1.0)/0.2; h+=dep*0.22*exp(-e*e); }
  return h; }
float roughH(vec2 w){                 /* mirrors rough() in core.js */
  float v=0.0,a=0.5,f=0.0295;
  for(int i=0;i<3;i++){ v+=a*vn2(w*f); a*=0.5; f*=2.03; }
  return (v-0.5)*2.3; }
/* SYNTHETIC (cosmetic): procedural highland relief BEYOND the LOLA window, used only to
   give the approach and the horizon somewhere to be. demH() clamps at the DEM edge, so the
   base surface is already continuous outward; the procedural relief is ramped in over
   ~35 km beyond the window so there is no wall at the data boundary. */
uniform vec2 uDemCtr; uniform float uDemHalf;
float regionalRelief(vec2 w){
  float ramp = smoothstep(uDemHalf*0.95, uDemHalf+35000.0, length(w-uDemCtr));
  if(ramp<=0.0) return 0.0;
  float b = fb2(w*0.00007,5)-0.5;
  float m = fb2(w*0.00042,4)-0.5;
  return (b*3400.0 + m*420.0 + craterField(w,9000.0,600.0,2600.0,0.055,3))*ramp; }
float terrainH(vec2 w, float dLocal){
  /* demH() clamps outside the DEM, which would extrude the edge profile into long radial
     streaks across the whole approach. Fade the measured field out over the same ramp the
     procedural relief fades in on, so far outside the window only synthetic terrain remains. */
  float keep = 1.0 - smoothstep(uDemHalf*0.98, uDemHalf+30000.0, length(w-uDemCtr));
  float base = demH(w)*keep + regionalRelief(w);
  float det = 0.0;
  if(dLocal < uDetailR){
    float f = 1.0-smoothstep(uDetailR*0.55, uDetailR, dLocal);
    det += (roughH(w) + craterField(w,70.0,4.0,14.0,0.06,0))*f; }
  if(dLocal < 4000.0) det += craterField(w,240.0,16.0,46.0,0.05,17)
                          *(1.0-smoothstep(2400.0,4000.0,dLocal));
  /* graded landing apron: DEM relief levelled, most of the fine texture retained */
  float ap = smoothstep(uApron0,uApron1,length(w));
  return base*ap + det*(0.30+0.70*ap); }
`;

if(typeof window!=='undefined') window.__GLSL__=GL_COMMON;
if(typeof module!=='undefined' && module.exports) module.exports=GL_COMMON;
