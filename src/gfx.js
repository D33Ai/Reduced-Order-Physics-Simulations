"use strict";
/* =======================================================================================
   D33 LUNAR CARGO MISSION v7 — GRAPHICS LAYER (raw WebGL2, no libraries, fully offline)

   Design notes that matter for realism:
   * ONE terrain system for the whole mission. A radial (polar) grid anchored under the
     camera, with geometrically growing ring spacing, mapped onto the lunar sphere exactly:
     a point at surface arc distance s sits at horizontal R*sin(s/R), vertical R*(cos(s/R)-1).
     That gives a true curved horizon at any altitude, from 100 km orbit down to the pad,
     with near-constant screen-space triangle size. Heights come from the real LOLA DEM
     inside the data window and from procedural relief (SYNTHETIC, cosmetic) beyond it.
   * The huge depth range is handled by two passes with separate frusta (far, then depth
     clear, then near) rather than logarithmic depth, so early-Z stays intact.
   * Terrain self-shadowing is read from the DEM sun-visibility raster computed in the core
     — exact, global and free. The shadow map therefore only has to carry vehicle/base
     casters, so one small map is enough even with the sun 1.5 deg above the horizon.
   * Linear HDR throughout; AgX applied once, in the post pass, after GPU auto-exposure.
   ======================================================================================= */
(function(){
if(typeof document==='undefined') return;
var A=window.__L7__, G=window.__GLSL__;
var GFX={};

/* ---------- quality tiers ---------- */
var isMobile=/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
GFX.QUAL={
  HIGH:{name:'HIGH', rings:190, segs:256, r0:0.85, shadow:2048, dust:4200, stars:2600,
        dpr:1.75, detailR:520, post:true},
  MED :{name:'MEDIUM', rings:150, segs:176, r0:1.10, shadow:1024, dust:2000, stars:1500,
        dpr:1.40, detailR:340, post:true},
  LOW :{name:'LOW', rings:112, segs:112, r0:1.60, shadow:0, dust:700, stars:800,
        dpr:1.00, detailR:190, post:false}
};
GFX.isMobile=isMobile;

var gl=null, cv=null, Q=null, EXT={};
var RES={shaders:[],programs:[],buffers:[],vaos:[],textures:[],fbos:[],rbos:[]};

GFX.init=function(canvas,quality){
  cv=canvas; Q=quality;
  gl=cv.getContext('webgl2',{antialias:false, alpha:false, depth:true,
    powerPreference:'high-performance', preserveDrawingBuffer:false});
  if(!gl) return null;
  EXT.colorFloat = gl.getExtension('EXT_color_buffer_float');
  EXT.floatBlend = gl.getExtension('EXT_float_blend');
  if(!EXT.colorFloat) Q.post=false;      /* graceful LDR fallback: tonemap inline */
  GFX.gl=gl; GFX.Q=Q; GFX.EXT=EXT;
  return gl;
};

/* ---------- resource helpers ---------- */
function sh(t,src,name){ var s=gl.createShader(t); RES.shaders.push(s);
  gl.shaderSource(s,src); gl.compileShader(s);
  if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)){
    var log=gl.getShaderInfoLog(s);
    throw new Error('shader compile ['+(name||'?')+']: '+log);
  }
  return s; }
var VH='#version 300 es\nprecision highp float;\nprecision highp int;\nprecision highp sampler2D;\n';
var FH='#version 300 es\nprecision highp float;\nprecision highp int;\nprecision highp sampler2D;\n';
function prog(vs,fs,name){ var p=gl.createProgram(); RES.programs.push(p);
  gl.attachShader(p,sh(gl.VERTEX_SHADER,VH+vs,name+'.vs'));
  gl.attachShader(p,sh(gl.FRAGMENT_SHADER,FH+fs,name+'.fs'));
  gl.linkProgram(p);
  if(!gl.getProgramParameter(p,gl.LINK_STATUS))
    throw new Error('link ['+name+']: '+gl.getProgramInfoLog(p));
  return p; }
function newBuf(){ var b=gl.createBuffer(); RES.buffers.push(b); return b; }
function newVao(){ var v=gl.createVertexArray(); RES.vaos.push(v); return v; }
function newTex(){ var t=gl.createTexture(); RES.textures.push(t); return t; }
function newFbo(){ var f=gl.createFramebuffer(); RES.fbos.push(f); return f; }
GFX.dispose=function(){
  RES.buffers.forEach(function(b){gl.deleteBuffer(b);});
  RES.vaos.forEach(function(v){gl.deleteVertexArray(v);});
  RES.programs.forEach(function(p){gl.deleteProgram(p);});
  RES.shaders.forEach(function(s){gl.deleteShader(s);});
  RES.textures.forEach(function(t){gl.deleteTexture(t);});
  RES.fbos.forEach(function(f){gl.deleteFramebuffer(f);});
  RES.rbos.forEach(function(r){gl.deleteRenderbuffer(r);});
  RES={shaders:[],programs:[],buffers:[],vaos:[],textures:[],fbos:[],rbos:[]};
};
function U(p,names){ var o={}; for(var i=0;i<names.length;i++)
  o[names[i]]=gl.getUniformLocation(p,'u'+names[i]); return o; }
GFX.U=U;

/* ======================================================================================
   PROGRAMS
   ====================================================================================== */
var P={}, UL={};
GFX.programs=P; GFX.uniforms=UL;

GFX.buildPrograms=function(){
  var SPHERE=`
  uniform float uR;             /* lunar radius, metres */
  uniform vec2  uFocus;         /* world XZ the tangent frame is built at */
  /* Exact sphere mapping of a locally-planar offset: arc distance s -> (R sin(s/R), R(cos(s/R)-1)). */
  vec3 toSphere(vec2 lp, float h){
    float s=length(lp);
    if(s<1e-4) return vec3(0.0,h,0.0);
    float a=s/uR, ca=cos(a), sa=sin(a);
    vec2 dir=lp/s;
    return vec3(dir.x*(uR+h)*sa, (uR+h)*ca-uR, dir.y*(uR+h)*sa); }
  `;
  GFX.SPHERE=SPHERE;

  /* ---------------- terrain ---------------- */
  P.ter=prog(
    G.NOISE+G.DEM+G.TERRAIN_H+SPHERE+`
    layout(location=0) in vec2 aXZ;     /* local offset from the anchor */
    layout(location=1) in float aStep;  /* local ring spacing, for the normal FD */
    uniform mat4 uVP;
    out vec3 vP; out vec3 vN; out vec2 vW; out float vD; out float vHgt;
    void main(){
      vec2 w = aXZ + uAnchor;
      float d = length(aXZ);
      /* Cap the FD step: at large radii the ring spacing reaches kilometres, and sampling the
         height field that coarsely averages all the relief out — distant terrain then shades
         as a flat grey sheet instead of showing its slopes. */
      float st = clamp(aStep*0.5, 0.6, 500.0);
      float h  = terrainH(w,d);
      float hx = terrainH(w+vec2(st,0.0),d), hz = terrainH(w+vec2(0.0,st),d);
      vec3 N = normalize(vec3(-(hx-h)/st, 1.0, -(hz-h)/st));
      vec3 sp = toSphere(aXZ,h);
      vP = sp + vec3(uFocus.x,0.0,uFocus.y);
      vW = w; vN = N; vD = d; vHgt = h;
      gl_Position = uVP*vec4(vP,1.0); }`,
    G.NOISE+G.AGX+G.VISION+G.REGOLITH+G.LAMPS+G.SHADOW+G.DEM+`
    uniform vec3 uSun, uEye; uniform float uSunIrr, uSunEl;
    uniform int uVision; uniform float uT;
    uniform int uIceN; uniform vec4 uIce[5]; uniform float uIceG[5];
    uniform vec4 uBlast;              /* xz centre, z radius, w strength */
    uniform float uEarthshine;
    in vec3 vP; in vec3 vN; in vec2 vW; in float vD; in float vHgt;
    out vec4 fc;
    void main(){
      vec3 N=normalize(vN), V=normalize(uEye-vP);
      vec2 aux=auxAt(vW);
      float sunVis=aux.x, meanIll=aux.y;

      /* --- albedo: highland regolith, FACT: normal albedo ~0.11-0.18 --- */
      float m1=fb2(vW*0.035,5), m2=dtl(vW*0.62);
      vec3 alb=vec3(0.132,0.128,0.121)*(0.80+0.34*m1+0.10*m2);
      /* engine-scoured zone: the plume strips the fine bright fraction, exposing darker,
         coarser material and leaving radial streaks. Cosmetic (labelled). */
      float bd=length(vW-uBlast.xy);
      float bl=uBlast.w*(1.0-smoothstep(uBlast.z*0.35,uBlast.z,bd));
      float streak=0.5+0.5*sin(atan(vW.y-uBlast.y,vW.x-uBlast.x)*26.0+vn2(vW*0.9)*6.0);
      alb*=mix(1.0,0.74+0.16*streak,clamp(bl,0.0,1.0));

      /* --- fine normal perturbation below the mesh resolution --- */
      float nf=clamp(1.0-vD/420.0,0.0,1.0);
      if(nf>0.0){
        float e=0.35;
        float d0=dtl(vW*1.7), dx=dtl((vW+vec2(e,0.0))*1.7), dz=dtl((vW+vec2(0.0,e))*1.7);
        N=normalize(N+vec3(-(dx-d0),0.0,-(dz-d0))*2.4*nf); }

      /* --- direct sun. At 1.5 deg elevation flat ground is lit at grazing incidence and
             is therefore dark; sun-facing slopes are brilliant. That contrast IS the
             south-polar look. --- */
      float shadow = sunVis*objectShadow(vP,N,uSun);
      vec3 col = regolith(alb,N,uSun,V,uSunIrr)*shadow;

      /* --- ground-bounce fill. No sky in vacuum: the only ambient is sunlight bounced off
             surrounding terrain, so it scales with the LOCAL irradiance, not a constant. --- */
      float horiz = 0.5+0.5*N.y;
      vec3 bounce = alb*uSunIrr*sin(max(uSunEl,0.0))*meanIll*0.30*horiz;
      /* --- earthshine: faint, and the only thing lighting permanent shadow --- */
      vec3 earth = alb*vec3(0.55,0.63,0.85)*uEarthshine*horiz;
      col += bounce + earth;
      col += alb*lampIrradiance(vP,N);

      /* --- logged cold traps read back as a faint frost sheen under the lamps --- */
      float ice=0.0;
      for(int i=0;i<5;i++){ if(i>=uIceN) break; vec4 d=uIce[i];
        float dd=distance(vW,d.xy);
        ice+=d.w*exp(-dd*dd/(2.0*d.z*d.z))*uIceG[i]; }
      col += vec3(0.30,0.52,0.85)*ice*min(length(lampIrradiance(vP,N))*4.0,1.0)*0.09;

      if(uVision==1){ fc=vec4(nvMap(col,gl_FragCoord.xy,uT),1.0); return; }
      if(uVision==2){
        /* radiative-equilibrium surface temperature, same law as the core */
        float cosi=max(N.y*sin(uSunEl)+sqrt(max(1.0-N.y*N.y,0.0))*cos(uSunEl)*0.5,0.0);
        float T=pow(max(1361.0*0.88*cosi*meanIll,0.0)/(0.95*5.670374419e-8)+2085136.0,0.25);
        vec3 tc=thermPal(thermT(T));
        /* Water-ice stability contour (FACT: ice is stable against sublimation over
           geological time below roughly 110 K). This is the line the survey is about. */
        float band=1.0-smoothstep(0.0,4.0,abs(T-110.0));
        tc=mix(tc,vec3(0.20,0.95,1.0),band*0.85);
        if(T<110.0) tc+=vec3(0.0,0.10,0.16);
        for(int i=0;i<5;i++){ if(i>=uIceN) break; vec4 d=uIce[i];
          float dd=distance(vW,d.xy);
          tc+=vec3(0.10,0.92,1.0)*smoothstep(28.0,7.0,abs(dd-d.z))*uIceG[i]*(0.5+0.5*sin(uT*3.0)); }
        fc=vec4(clamp(tc,0.0,1.0),1.0); return; }
      fc=outc(col); }`,'terrain');
  UL.ter=U(P.ter,['VP','R','Focus','Anchor','Dem','Aux','DemA','DemB','DemN','DemCtr','DemHalf','DetailR',
    'Apron0','Apron1','BlastR','Blast','Sun','Eye','SunIrr','SunEl','Vision','T','IceN',
    'Earthshine','LampOn','Lp0','Ld0','Lp1','Ld1','Flood','LampI','ShadowVP','ShadowTex',
    'ShadowOn','ShadowTexel','Post','EV']);
  UL.terIce=[]; UL.terIceG=[];
  for(var i=0;i<5;i++){ UL.terIce.push(gl.getUniformLocation(P.ter,'uIce['+i+']'));
    UL.terIceG.push(gl.getUniformLocation(P.ter,'uIceG['+i+']')); }

  /* ---------------- vehicle / structure parts (GGX + Fresnel) ---------------- */
  P.part=prog(
    `layout(location=0) in vec3 aP; layout(location=1) in vec3 aN;
     uniform mat4 uVP,uPose,uM; out vec3 vP,vN,vL;
     void main(){ vec4 w=uPose*uM*vec4(aP,1.0); vP=w.xyz; vL=aP;
       vN=mat3(uPose)*mat3(uM)*aN; gl_Position=uVP*w; }`,
    G.NOISE+G.AGX+G.VISION+G.LAMPS+G.SHADOW+`
    uniform vec3 uSun,uEye,uColor; uniform float uSunIrr;
    uniform float uMetal,uRough,uEmis,uFoil,uTempK,uLit,uEarthshine,uSunEl;
    uniform int uVision; uniform float uT;
    in vec3 vP,vN,vL; out vec4 fc;
    float D_GGX(float NoH,float a){ float a2=a*a, d=(NoH*NoH*(a2-1.0)+1.0);
      return a2/(3.14159265*d*d); }
    float V_Smith(float NoV,float NoL,float a){ float k=a*0.5;
      float gv=NoL*(NoV*(1.0-k)+k), gl2=NoV*(NoL*(1.0-k)+k); return 0.5/max(gv+gl2,1e-4); }
    vec3 fresnel(float c,vec3 F0){ return F0+(1.0-F0)*pow(clamp(1.0-c,0.0,1.0),5.0); }
    void main(){
      vec3 N=normalize(vN), V=normalize(uEye-vP), alb=uColor;
      float rough=clamp(uRough,0.045,1.0);
      if(uFoil>0.5){
        /* multi-layer insulation: crinkled, anisotropic-looking, very glossy metal */
        float w=vn2(vL.xz*14.0+vL.yy*9.0);
        alb*=0.80+0.40*w; rough=clamp(rough*(0.55+0.9*w),0.05,1.0);
        N=normalize(N+0.22*vec3(vn2(vL.yz*17.0)-0.5,vn2(vL.xy*15.0)-0.5,vn2(vL.zx*16.0)-0.5)); }
      vec3 F0=mix(vec3(0.04),alb,uMetal);
      vec3 diff=alb*(1.0-uMetal);
      float shadow=uLit*objectShadow(vP,N,uSun);
      float NoL=max(dot(N,uSun),0.0), NoV=max(dot(N,V),1e-4);
      vec3 col=vec3(0.0);
      if(NoL>0.0){
        vec3 H=normalize(uSun+V); float NoH=max(dot(N,H),0.0), VoH=max(dot(V,H),0.0);
        float a=rough*rough;
        vec3 spec=fresnel(VoH,F0)*D_GGX(NoH,a)*V_Smith(NoV,NoL,a);
        col += (diff/3.14159265 + spec)*uSunIrr*NoL*shadow*3.14159265; }
      /* ambient: ground bounce (regolith-tinted) + earthshine, both tiny in vacuum */
      float up=0.5+0.5*N.y;
      vec3 amb=vec3(0.13,0.126,0.119)*uSunIrr*sin(max(uSunEl,0.0))*0.45;
      col += diff*(amb*up + vec3(0.55,0.63,0.85)*uEarthshine*up);
      col += diff*lampIrradiance(vP,N);
      col += uColor*uEmis;
      if(uVision==1){ fc=vec4(nvMap(col+uColor*uEmis*1.5,gl_FragCoord.xy,uT),1.0); return; }
      if(uVision==2){ fc=vec4(thermPal(thermT(uTempK)),1.0); return; }
      fc=outc(col); }`,'part');
  UL.part=U(P.part,['VP','Pose','M','Sun','Eye','Color','SunIrr','Metal','Rough','Emis',
    'Foil','TempK','Lit','Vision','T','Earthshine','SunEl','LampOn','Lp0','Ld0','Lp1','Ld1',
    'Flood','LampI','ShadowVP','ShadowTex','ShadowOn','ShadowTexel','Post','EV']);

  /* ---------------- shadow caster (depth only) ---------------- */
  P.depth=prog(
    `layout(location=0) in vec3 aP; uniform mat4 uVP,uPose,uM;
     void main(){ gl_Position=uVP*uPose*uM*vec4(aP,1.0); }`,
    `out vec4 fc; void main(){ fc=vec4(1.0); }`,'depth');
  UL.depth=U(P.depth,['VP','Pose','M']);

  /* ---------------- engine plume ----------------
     FACT: a vacuum nozzle plume is under-expanded — it flares into a wide, faint,
     translucent cone with no atmospheric shock structure and no billowing. It is much
     dimmer and much wider than the sea-level flame people expect. */
  P.plume=prog(
    `layout(location=0) in vec3 aP; uniform mat4 uVP,uPose,uM; uniform float uThr;
     out vec3 vL;
     void main(){ vec3 p=aP;
       float yn=clamp(-aP.y/3.2,0.0,1.0);
       p.xz *= 1.0 + yn*yn*3.4*(0.45+0.55*uThr);   /* under-expanded flare */
       p.y  *= 0.55+0.85*uThr;
       vL=aP; gl_Position=uVP*uPose*uM*vec4(p,1.0); }`,
    G.NOISE+G.AGX+`
    uniform float uT,uThr; in vec3 vL; out vec4 fc;
    void main(){
      /* FACT: an Apollo-class hypergolic engine firing in vacuum shows almost no visible
         flame — the descent films show dust, not fire. Keep the plume a faint, wide,
         translucent haze; anything brighter reads as a sea-level rocket and, against
         terrain lit at 1.5 deg, blooms into white blobs that swallow the vehicle. */
      float yn=clamp(-vL.y/3.2,0.0,1.0);
      float r=length(vL.xz)/(0.34+yn*0.9);
      float core=1.0-smoothstep(0.0,1.0,r);
      float flick=0.88+0.12*vn2(vec2(vL.y*3.0-uT*30.0, atan(vL.z,vL.x)*2.2));
      vec3 c=mix(vec3(0.34,0.44,0.95), vec3(0.72,0.80,1.0), core);
      float a=(0.004+0.030*core*core)*(1.0-yn*0.80)*flick*uThr;
      fc=vec4(c*(0.05+0.30*core*core)*uThr*flick, a); }`,'plume');
  UL.plume=U(P.plume,['VP','Pose','M','T','Thr','Post','EV']);

  /* ---------------- plume-ejected dust ----------------
     FACT (Apollo 11/12/15 landing films, Chang'e): in vacuum the exhaust scours a SHEET of
     regolith that leaves at a few degrees above horizontal at tens of m/s and flies
     ballistically to the horizon. It does not billow, hang, or settle slowly. The sheet is
     forward-scattering, so it flares when it passes between the camera and the sun. */
  P.dust=prog(
    `layout(location=0) in vec3 aP; layout(location=1) in float aL;
     layout(location=2) in float aS;
     uniform mat4 uVP; uniform float uPS; out float vL; out float vS;
     void main(){ vL=aL; vS=aS; vec4 c=uVP*vec4(aP,1.0);
       gl_Position=c; gl_PointSize=clamp(uPS*aS/max(c.w,1.0),1.0,11.0); }`,
    G.AGX+`
    uniform vec3 uSun,uEye,uFwd; uniform float uSunIrr,uSunEl;
    in float vL; in float vS; out vec4 fc;
    void main(){
      if(vL<=0.0) discard;
      vec2 d=gl_PointCoord-0.5; float r2=dot(d,d);
      if(r2>0.25) discard;
      float soft=1.0-smoothstep(0.06,0.25,r2);
      /* forward scattering: bright when the grain sits between the eye and the sun */
      float fwd=pow(clamp(dot(normalize(-uFwd),uSun)*0.5+0.5,0.0,1.0),3.0);
      float lit=uSunIrr*(0.16+1.5*fwd)*sin(max(uSunEl,0.0)+0.25);
      vec3 c=vec3(0.14,0.135,0.128)*lit;
      fc=outc(c*soft*vL)*vec4(1.0,1.0,1.0,soft*vL*0.55); }`,'dust');
  UL.dust=U(P.dust,['VP','PS','Sun','Eye','Fwd','SunIrr','SunEl','Post','EV']);

  /* ---------------- stars ----------------
     Real magnitudes; with auto-exposure they vanish when the camera is stopped down for
     sunlit terrain and appear in shadow, which is exactly what a real camera does. */
  P.star=prog(
    `layout(location=0) in vec3 aP; layout(location=1) in float aM;
     uniform mat4 uVP; uniform float uPS; out float vM;
     void main(){ vM=aM; vec4 p=uVP*vec4(aP,0.0); gl_Position=p.xyww;
       gl_PointSize=clamp(uPS*(0.45+aM*0.55),1.0,3.0); }`,
    G.AGX+`
    in float vM; out vec4 fc;
    void main(){ vec2 d=gl_PointCoord-0.5; float r=dot(d,d);
      if(r>0.25) discard;
      float f=(1.0-r*4.0);
      /* Faint on purpose: exposed for sunlit regolith a real camera shows no stars at all,
         and they only emerge once the auto-exposure opens up in shadow. */
      fc=outc(vec3(0.85,0.90,1.0)*vM*f*0.0012); }`,'stars');
  UL.star=U(P.star,['VP','PS','Post','EV']);

  /* ---------------- sun disc + Earth ---------------- */
  P.disc=prog(
    `layout(location=0) in vec2 aP; uniform mat4 uVP; uniform vec3 uCenter;
     uniform vec2 uSize; uniform vec3 uRight,uUp; out vec2 vUV;
     void main(){ vUV=aP; vec3 w=uCenter+uRight*(aP.x*uSize.x)+uUp*(aP.y*uSize.y);
       vec4 p=uVP*vec4(w,0.0); gl_Position=p.xyww; }`,
    G.NOISE+G.AGX+`
    uniform int uKind; uniform vec3 uSun; uniform float uIntensity;
    in vec2 vUV; out vec4 fc;
    void main(){
      float r=length(vUV);
      if(uKind==0){                       /* sun: hard limb plus a little glare */
        if(r>1.0) discard;
        float disc=1.0-smoothstep(0.90,1.0,r);
        fc=outc(vec3(1.0,0.985,0.96)*uIntensity*disc); return; }
      /* Earth: phase-lit sphere, ~1.9 deg across from the Moon */
      if(r>1.0) discard;
      vec3 n=vec3(vUV, sqrt(max(1.0-r*r,0.0)));
      float lam=max(dot(n,normalize(uSun)),0.0);
      float land=smoothstep(0.48,0.58,fb2(vec2(atan(n.z,n.x)*1.6,n.y*2.4),4));
      float cl=smoothstep(0.50,0.74,fb2(vec2(atan(n.z,n.x)*2.6,n.y*3.4)+11.0,4));
      vec3 alb=mix(vec3(0.03,0.07,0.22),vec3(0.09,0.20,0.07),land);
      alb=mix(alb,vec3(0.75),cl*0.8);
      float limb=1.0-smoothstep(0.93,1.0,r);
      fc=outc(alb*lam*uIntensity*limb); }`,'disc');
  UL.disc=U(P.disc,['VP','Center','Size','Right','Up','Kind','Sun','Intensity','Post','EV']);

  if(Q.post) buildPost();
};

/* ======================================================================================
   POST CHAIN: auto-exposure (GPU, ping-pong 1x1) -> bloom (Karis dual-filter) -> AgX
   ====================================================================================== */
var POST={};
GFX.POST=POST;
var QUADV=null;
function quadVao(){
  if(QUADV) return QUADV;
  var v=newVao(); gl.bindVertexArray(v);
  var b=newBuf(); gl.bindBuffer(gl.ARRAY_BUFFER,b);
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1, 3,-1, -1,3]),gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
  gl.bindVertexArray(null); QUADV=v; return v;
}
GFX.quadVao=quadVao;
var QUAD_VS=`layout(location=0) in vec2 aP; out vec2 vUV;
  void main(){ vUV=aP*0.5+0.5; gl_Position=vec4(aP,0.0,1.0); }`;

function buildPost(){
  POST.lum=prog(QUAD_VS,
    `uniform sampler2D uSrc; uniform sampler2D uPrev; uniform float uK;
     in vec2 vUV; out vec4 fc;
     void main(){
       float s=0.0;
       for(int y=0;y<6;y++) for(int x=0;x<6;x++){
         vec2 uv=(vec2(float(x),float(y))+0.5)/6.0;
         vec3 c=textureLod(uSrc,uv,5.0).rgb;
         s += log(max(dot(c,vec3(0.2126,0.7152,0.0722)),1e-6)); }
       float cur=exp(s/36.0);
       float prev=texture(uPrev,vec2(0.5)).r;
       if(prev<=0.0) prev=cur;
       fc=vec4(mix(prev,cur,uK),0.0,0.0,1.0); }`,'lum');
  POST.lumU=U(POST.lum,['Src','Prev','K']);

  POST.bright=prog(QUAD_VS,
    `uniform sampler2D uSrc; uniform sampler2D uLum; uniform float uThresh, uEVBias;
     in vec2 vUV; out vec4 fc;
     float karis(vec3 c){ return 1.0/(1.0+max(max(c.r,c.g),c.b)); }
     void main(){
       vec2 t=1.0/vec2(textureSize(uSrc,0));
       vec3 a=texture(uSrc,vUV+vec2(-t.x,-t.y)).rgb, b=texture(uSrc,vUV+vec2(t.x,-t.y)).rgb;
       vec3 c=texture(uSrc,vUV+vec2(-t.x, t.y)).rgb, d=texture(uSrc,vUV+vec2(t.x, t.y)).rgb;
       float wa=karis(a),wb=karis(b),wc=karis(c),wd=karis(d);
       vec3 s=(a*wa+b*wb+c*wc+d*wd)/max(wa+wb+wc+wd,1e-4);
       float L=texture(uLum,vec2(0.5)).r;
       float ev=uEVBias-log2(max(L,1e-5))-1.0;
       s*=exp2(ev);
       float lum=dot(s,vec3(0.2126,0.7152,0.0722));
       fc=vec4(s*smoothstep(uThresh,uThresh*2.0,lum),1.0); }`,'bright');
  POST.brightU=U(POST.bright,['Src','Lum','Thresh','EVBias']);

  POST.blur=prog(QUAD_VS,
    `uniform sampler2D uSrc; uniform vec2 uDir; in vec2 vUV; out vec4 fc;
     void main(){ vec2 t=uDir/vec2(textureSize(uSrc,0));
       vec3 s=texture(uSrc,vUV).rgb*0.2270270270;
       s+=texture(uSrc,vUV+t*1.3846153846).rgb*0.3162162162;
       s+=texture(uSrc,vUV-t*1.3846153846).rgb*0.3162162162;
       s+=texture(uSrc,vUV+t*3.2307692308).rgb*0.0702702703;
       s+=texture(uSrc,vUV-t*3.2307692308).rgb*0.0702702703;
       fc=vec4(s,1.0); }`,'blur');
  POST.blurU=U(POST.blur,['Src','Dir']);

  POST.comp=prog(QUAD_VS,
    G.NOISE+G.AGX+`
    uniform sampler2D uScene, uBloom, uLumT;
    uniform float uEVBias, uBloomAmt, uT, uGrain, uVign, uCA;
    in vec2 vUV; out vec4 fc;
    void main(){
      float L=texture(uLumT,vec2(0.5)).r;
      float ev=uEVBias-log2(max(L,1e-5))-1.0;
      float e=exp2(ev);
      vec2 d=vUV-0.5;
      /* very slight lateral chromatic aberration at the frame edge */
      float ca=uCA*dot(d,d);
      vec3 c;
      c.r=texture(uScene,vUV+d*ca).r;
      c.g=texture(uScene,vUV).g;
      c.b=texture(uScene,vUV-d*ca).b;
      c*=e;
      c+=texture(uBloom,vUV).rgb*uBloomAmt;
      vec3 o=agxEotf(agxLook(agx(max(c,0.0))));
      o*=1.0-uVign*dot(d,d)*1.35;                       /* vignette */
      o+=(h21(vUV*vec2(1920.0,1080.0)+fract(uT)*137.0)-0.5)*uGrain;  /* fine grain */
      fc=vec4(max(o,0.0),1.0); }`,'comp');
  POST.compU=U(POST.comp,['Scene','Bloom','LumT','EVBias','BloomAmt','T','Grain','Vign','CA','Post','EV']);
}

/* ---------- render targets ---------- */
function mkTex(w,h,ifmt,fmt,type,filter,wrap){
  var t=newTex(); gl.bindTexture(gl.TEXTURE_2D,t);
  gl.texImage2D(gl.TEXTURE_2D,0,ifmt,w,h,0,fmt,type,null);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,filter);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,filter===gl.LINEAR_MIPMAP_LINEAR?gl.LINEAR:filter);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,wrap||gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,wrap||gl.CLAMP_TO_EDGE);
  return t;
}
GFX.mkTex=mkTex;
var RT={w:0,h:0};
GFX.RT=RT;
GFX.resizeTargets=function(w,h){
  if(!Q.post) { RT.w=w; RT.h=h; return; }
  if(RT.w===w&&RT.h===h&&RT.scene) return;
  RT.w=w; RT.h=h;
  if(RT.fbo){ gl.deleteFramebuffer(RT.fbo); gl.deleteTexture(RT.scene); gl.deleteRenderbuffer(RT.depth); }
  RT.scene=mkTex(w,h,gl.RGBA16F,gl.RGBA,gl.HALF_FLOAT,gl.LINEAR_MIPMAP_LINEAR);
  RT.depth=gl.createRenderbuffer(); RES.rbos.push(RT.depth);
  gl.bindRenderbuffer(gl.RENDERBUFFER,RT.depth);
  gl.renderbufferStorage(gl.RENDERBUFFER,gl.DEPTH_COMPONENT24,w,h);
  RT.fbo=newFbo(); gl.bindFramebuffer(gl.FRAMEBUFFER,RT.fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,RT.scene,0);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.RENDERBUFFER,RT.depth);
  var bw=Math.max(2,w>>2), bh=Math.max(2,h>>2);
  if(RT.bloomA){ gl.deleteTexture(RT.bloomA); gl.deleteTexture(RT.bloomB); }
  RT.bloomA=mkTex(bw,bh,gl.RGBA16F,gl.RGBA,gl.HALF_FLOAT,gl.LINEAR);
  RT.bloomB=mkTex(bw,bh,gl.RGBA16F,gl.RGBA,gl.HALF_FLOAT,gl.LINEAR);
  RT.bw=bw; RT.bh=bh;
  if(!RT.fboB){ RT.fboB=newFbo(); }
  if(!RT.lum){
    RT.lum=[mkTex(1,1,gl.R16F,gl.RED,gl.HALF_FLOAT,gl.NEAREST),
            mkTex(1,1,gl.R16F,gl.RED,gl.HALF_FLOAT,gl.NEAREST)];
    RT.lumFbo=[newFbo(),newFbo()];
    for(var i=0;i<2;i++){ gl.bindFramebuffer(gl.FRAMEBUFFER,RT.lumFbo[i]);
      gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,RT.lum[i],0);
      gl.clearColor(0,0,0,1); gl.clear(gl.COLOR_BUFFER_BIT); }
    RT.lumPing=0;
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER,null);
};

/* ---------- shadow map ---------- */
GFX.buildShadow=function(){
  if(!Q.shadow){ GFX.shadow=null; return; }
  var s=Q.shadow;
  var t=newTex(); gl.bindTexture(gl.TEXTURE_2D,t);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.DEPTH_COMPONENT24,s,s,0,gl.DEPTH_COMPONENT,gl.UNSIGNED_INT,null);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  var f=newFbo(); gl.bindFramebuffer(gl.FRAMEBUFFER,f);
  gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.TEXTURE_2D,t,0);
  gl.drawBuffers([gl.NONE]); gl.readBuffer(gl.NONE);
  var ok=gl.checkFramebufferStatus(gl.FRAMEBUFFER)===gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER,null);
  GFX.shadow= ok ? {tex:t,fbo:f,size:s,texel:1/s} : null;
};

/* ======================================================================================
   GEOMETRY
   ====================================================================================== */
/* Radial terrain grid: `rings` concentric circles of `segs` segments, radius growing
   geometrically so screen-space triangle size stays roughly constant from 1 m to 2800 km.
   Split into a near range and a far range so the two depth passes can each draw a slice. */
GFX.buildTerrainGrid=function(rMax){
  var R=Q.rings, S=Q.segs, r0=Q.r0;
  var g=Math.pow(rMax/r0,1/(R-1));
  var nv=R*S+1, XZ=new Float32Array(nv*2), ST=new Float32Array(nv);
  var radii=new Float32Array(R);
  XZ[0]=0; XZ[1]=0; ST[0]=r0*0.7;
  var vi=1, i,j;
  for(i=0;i<R;i++){
    var r=r0*Math.pow(g,i); radii[i]=r;
    var step=r*(g-1)*1.2+r*2*Math.PI/S*0.5;
    for(j=0;j<S;j++){
      var a=j/S*Math.PI*2;
      XZ[vi*2]=Math.cos(a)*r; XZ[vi*2+1]=Math.sin(a)*r; ST[vi]=step; vi++;
    }
  }
  var idx=[], splitIdx=-1, splitR=20000;
  for(j=0;j<S;j++) idx.push(0, 1+j, 1+(j+1)%S);          /* centre fan */
  for(i=0;i<R-1;i++){
    if(splitIdx<0 && radii[i]>splitR) splitIdx=idx.length;
    var a0=1+i*S, b0=1+(i+1)*S;
    for(j=0;j<S;j++){
      var jn=(j+1)%S;
      idx.push(a0+j, b0+j, a0+jn);
      idx.push(a0+jn, b0+j, b0+jn);
    }
  }
  if(splitIdx<0) splitIdx=idx.length;
  var I=new Uint32Array(idx);
  var v=newVao(); gl.bindVertexArray(v);
  var b1=newBuf(); gl.bindBuffer(gl.ARRAY_BUFFER,b1);
  gl.bufferData(gl.ARRAY_BUFFER,XZ,gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
  var b2=newBuf(); gl.bindBuffer(gl.ARRAY_BUFFER,b2);
  gl.bufferData(gl.ARRAY_BUFFER,ST,gl.STATIC_DRAW);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1,1,gl.FLOAT,false,0,0);
  var ib=newBuf(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,ib);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,I,gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  return {vao:v, nearCount:splitIdx, farOffset:splitIdx, farCount:I.length-splitIdx,
          total:I.length, tris:I.length/3, rMax:rMax};
};

GFX.vaoPNI=function(g){
  var v=newVao(); gl.bindVertexArray(v);
  var b=newBuf(); gl.bindBuffer(gl.ARRAY_BUFFER,b);
  gl.bufferData(gl.ARRAY_BUFFER,g.P,gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,3,gl.FLOAT,false,0,0);
  var n=newBuf(); gl.bindBuffer(gl.ARRAY_BUFFER,n);
  gl.bufferData(gl.ARRAY_BUFFER,g.N,gl.STATIC_DRAW);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1,3,gl.FLOAT,false,0,0);
  var i=newBuf(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,i);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,g.I,gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  return {vao:v,n:g.I.length,
    type:(g.I instanceof Uint32Array)?gl.UNSIGNED_INT:gl.UNSIGNED_SHORT,tris:g.I.length/3};
};

GFX.uploadDem=function(dem,vis){
  var N=dem.N;
  var el=newTex(); gl.bindTexture(gl.TEXTURE_2D,el);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.R32F,N,N,0,gl.RED,gl.FLOAT,dem.elevPad);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  var aux=new Uint8Array(N*N*2);
  for(var i=0;i<N*N;i++){ aux[i*2]=Math.round(A.clamp(vis[i],0,1)*255);
    aux[i*2+1]=Math.round(A.clamp(dem.ill[i],0,1)*255); }
  var at=newTex(); gl.bindTexture(gl.TEXTURE_2D,at);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RG8,N,N,0,gl.RG,gl.UNSIGNED_BYTE,aux);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT,4);
  return {elev:el, aux:at, N:N};
};

GFX.buildStars=function(){
  var rng=A.makeRng(0x51ed), n=Q.stars;
  var SP=new Float32Array(n*3), SM=new Float32Array(n);
  for(var i=0;i<n;i++){
    var a=rng()*Math.PI*2, e=Math.asin(rng()*2-1), ce=Math.cos(e);
    SP[i*3]=Math.cos(a)*ce; SP[i*3+1]=Math.sin(e); SP[i*3+2]=Math.sin(a)*ce;
    var u=rng(); SM[i]=0.18+u*u*u*2.6;
  }
  var v=newVao(); gl.bindVertexArray(v);
  var b=newBuf(); gl.bindBuffer(gl.ARRAY_BUFFER,b);
  gl.bufferData(gl.ARRAY_BUFFER,SP,gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,3,gl.FLOAT,false,0,0);
  var m=newBuf(); gl.bindBuffer(gl.ARRAY_BUFFER,m);
  gl.bufferData(gl.ARRAY_BUFFER,SM,gl.STATIC_DRAW);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1,1,gl.FLOAT,false,0,0);
  gl.bindVertexArray(null);
  return {vao:v,n:n};
};

GFX.buildDiscQuad=function(){
  var v=newVao(); gl.bindVertexArray(v);
  var b=newBuf(); gl.bindBuffer(gl.ARRAY_BUFFER,b);
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1, 1,-1, 1,1, -1,-1, 1,1, -1,1]),gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
  gl.bindVertexArray(null);
  return {vao:v,n:6};
};

/* Dust buffers: CPU ballistic integration, GPU point sprites. */
GFX.buildDust=function(){
  var n=Q.dust;
  var d={n:n, P:new Float32Array(n*3), V:new Float32Array(n*3),
         L:new Float32Array(n), S:new Float32Array(n), head:0};
  d.vao=newVao(); gl.bindVertexArray(d.vao);
  d.pb=newBuf(); gl.bindBuffer(gl.ARRAY_BUFFER,d.pb);
  gl.bufferData(gl.ARRAY_BUFFER,d.P,gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,3,gl.FLOAT,false,0,0);
  d.lb=newBuf(); gl.bindBuffer(gl.ARRAY_BUFFER,d.lb);
  gl.bufferData(gl.ARRAY_BUFFER,d.L,gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1,1,gl.FLOAT,false,0,0);
  d.sb=newBuf(); gl.bindBuffer(gl.ARRAY_BUFFER,d.sb);
  gl.bufferData(gl.ARRAY_BUFFER,d.S,gl.STATIC_DRAW);
  gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2,1,gl.FLOAT,false,0,0);
  gl.bindVertexArray(null);
  return d;
};

window.__GFX__=GFX;
})();
