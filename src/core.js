"use strict";
/* =======================================================================================
   D33 LUNAR CARGO MISSION v7 "COLDWATER" — PURE CORE (no GL, no DOM)

   Terrain, illumination and mission sites are derived from REAL LOLA topography.
   Source: NASA PDS Geosciences / LRO LOLA GDR polar DEM  ldem_875s_5m  (5 m/px,
   polar stereographic, south pole). Window: 25.6 km centred on the lunar south pole,
   resampled to 512x512 @ 50 m. Elevation is metres relative to a 1737.4 km sphere.

   v7 physics changes over v6 (all F2 reduced-order, planar, point-mass + pitch axis):
     * The descent is now flown from orbit: DOI (vis-viva), coast, PDI at 15.2 km /
       1692 m/s, braking phase, approach, terminal, touchdown. Nothing is "handed over".
     * Planar dynamics carry the curvature terms (vx^2/r lift, vx*vh/r coupling) and
       1/r^2 gravity, so a coasting vehicle at periapsis stays in orbit as it should.
     * Guidance is ZEM/ZEV (Apollo E-guidance family) on the NAVIGATED state, targeting
       the pad. v6 flew a velocity profile with no position loop, so the landing
       ellipse was an artefact of the guidance, not of navigation.
     * Navigation carries a downrange position error: orbit-determination error before
       a fix, then beacon-aided (or map-TRN) error after. Monte Carlo runs both.
     * The mass budget closes: dry 26 t, 27 t propellant, Isp 320 s -> 2236 m/s.
     * Touchdown is on the real terrain height under the vehicle, not a datum plane.
     * The terrain field separates the LOLA DEM (used for every screening number)
       from the synthetic sub-grid relief (roughness + small craters, cosmetic).
     * Sun-visibility raster for the actual sun azimuth (row sweep on the DEM with a
       0.53 deg solar-disc penumbra), separate from the 24-azimuth mean map.
   ======================================================================================= */
var G_MOON=1.625, G0=9.80665, GM_MOON=4.9028e12, GM_MOON_KM=4902.8, R_MOON=1737400.0;
var DEG=180/Math.PI, RAD=Math.PI/180;
function clamp(v,a,b){ return v<a?a:(v>b?b:v); }
function smoothstep(a,b,x){ var t=clamp((x-a)/(b-a),0,1); return t*t*(3-2*t); }
function makeRng(seed){ var s=(seed>>>0)||1;
  return function(){ s=(1664525*s+1013904223)>>>0; return s/4294967296; }; }
function gauss(rng){ var u=Math.max(rng(),1e-9), v=rng();
  return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v); }
function angW(a){ while(a>Math.PI)a-=2*Math.PI; while(a<-Math.PI)a+=2*Math.PI; return a; }

/* ---------------- DEM decode ---------------- */
function b64bytes(b64){
  var bin=(typeof atob!=='undefined')?atob(b64):Buffer.from(b64,'base64').toString('binary');
  var n=bin.length, out=new Uint8Array(n);
  for(var i=0;i<n;i++) out[i]=bin.charCodeAt(i);
  return out;
}
/* zlib inflate via DecompressionStream when present; Node zlib in the harness. */
function inflate(bytes){
  if(typeof DecompressionStream!=='undefined'){
    var ds=new DecompressionStream('deflate');
    var stream=new Blob([bytes]).stream().pipeThrough(ds);
    return new Response(stream).arrayBuffer().then(function(ab){ return new Uint8Array(ab); });
  }
  if(typeof require!=='undefined'){
    var zlib=require('zlib');
    return Promise.resolve(new Uint8Array(zlib.inflateSync(Buffer.from(bytes))));
  }
  return Promise.reject(new Error('No inflate available (needs DecompressionStream).'));
}
function decodeDEM(asset){
  return Promise.all([inflate(b64bytes(asset.elevB64)), inflate(b64bytes(asset.illB64))])
    .then(function(r){
      var N=asset.n, q=asset.quant;
      var d=new Int16Array(r[0].buffer, r[0].byteOffset, N*N);   /* row-delta coded */
      var elev=new Float32Array(N*N);
      for(var y=0;y<N;y++){ var acc=0, o=y*N;
        for(var x=0;x<N;x++){ acc+=d[o+x]; elev[o+x]=acc*q; } }
      var illu=new Float32Array(N*N), iu=r[1];
      for(var i=0;i<N*N;i++) illu[i]=iu[i]/255;
      return {N:N, px:asset.px, elev:elev, ill:illu};
    });
}

/* ---------------- sun visibility raster (directional, actual azimuth) ----------------
   FACT: a DEM cell is sunlit at solar elevation `el` iff no cell towards the sun rises
   above the ray. With the sun along +x this is a per-row sweep in O(N) (running max of
   the ray height). Run at 5 elevations spanning the 0.53 deg solar disc and average, so
   shadow edges carry a physically-motivated penumbra instead of a hard step.
   The 24-azimuth MEAN map (`ill`) is kept for the science layer (PSR, temperature). */
function sunVisibility(dem, sunElDeg){
  var N=dem.N, PX=dem.px, E=dem.elev, vis=new Float32Array(N*N);
  var offs=[-0.265,-0.1325,0,0.1325,0.265], w=1/offs.length;
  for(var k=0;k<offs.length;k++){
    var tanEl=Math.tan((sunElDeg+offs[k])*RAD)*PX;
    for(var y=0;y<N;y++){ var o=y*N, H=-1e9;
      for(var x=N-1;x>=0;x--){
        if(E[o+x]>=H-0.01) vis[o+x]+=w;
        H=Math.max(E[o+x],H)-tanEl;
      }
    }
  }
  return vis;
}

/* ---------------- terrain field ---------------- */
/* World frame: x east (towards the sun), z south-ish, y up. Origin = landing pad. Metres. */
var SITE={ apronR0:80, apronR1:135 };   /* ASSUMPTION: graded apron around the pad (site prep by the base crew) */
function makeTerrain(dem, asset){
  var N=dem.N, PX=dem.px, E=dem.elev, IL=dem.ill;
  var VIS=sunVisibility(dem, asset.sunElDeg);
  var padX=asset.pad.x, padY=asset.pad.y, padE=asset.pad.elev;
  function cellToWorld(cx,cy){ return [ (cx-padX)*PX, (cy-padY)*PX ]; }
  function worldToCell(x,z){ return [ x/PX+padX, z/PX+padY ]; }
  function sampleBil(arr,fx,fy){
    fx=clamp(fx,0,N-1.001); fy=clamp(fy,0,N-1.001);
    var x0=Math.floor(fx), y0=Math.floor(fy), tx=fx-x0, ty=fy-y0;
    var i0=y0*N+x0, i1=i0+N;
    return (arr[i0]*(1-tx)+arr[i0+1]*tx)*(1-ty) + (arr[i1]*(1-tx)+arr[i1+1]*tx)*ty;
  }
  /* ---- synthetic sub-DEM relief: roughness + small-crater field ----
     LABEL: ASSUMPTION (cosmetic / trafficability texture), NOT measured topography.
     It is excluded from every screening number; see heightDem().

     The hash is INTEGER-based on purpose. The renderer evaluates the identical field on
     the GPU to displace terrain vertices, and vehicles are placed using these CPU values —
     so the two must agree bit-for-bit. A sin()-based hash does not: at these world
     coordinates the argument exceeds float32 precision and the GPU and CPU diverge
     completely, which would leave the rover floating or sunk. Integer multiply/xor/shift
     is exact in both GLSL ES 3.0 (uint) and JS (Math.imul), so both sides match. */
  function hashU(x,y){
    var h=(Math.imul(x|0,374761393)+Math.imul(y|0,668265263))|0;
    h=Math.imul(h^(h>>>13),1274126177)|0;
    return ((h^(h>>>16))>>>0);
  }
  function h21(x,y){ return hashU(x,y)/4294967296; }
  function vn(x,z){ var ix=Math.floor(x), iz=Math.floor(z), ux=x-ix, uz=z-iz;
    ux=ux*ux*(3-2*ux); uz=uz*uz*(3-2*uz);
    var a=h21(ix,iz), b=h21(ix+1,iz), c=h21(ix,iz+1), d=h21(ix+1,iz+1);
    return a+(b-a)*ux+(c-a)*uz+(a-b-c+d)*ux*uz; }
  var DET_AMP=2.3;                                   /* metres, peak-to-peak sub-grid roughness */
  function rough(x,z){
    var v=0,a=0.5,f=0.0295;
    for(var i=0;i<3;i++){ v+=a*vn(x*f,z*f); a*=0.5; f*=2.03; }
    return (v-0.5)*DET_AMP;
  }
  /* Small craters: cell-hashed bowls with a raised rim. Degraded depth/diameter 0.05-0.06
     (ESTIMATE: typical for the sub-100 m population on old highland surfaces). */
  function craterCell(x,z,cell,rMin,rMax,dD,seed){
    var gx=Math.floor(x/cell), gz=Math.floor(z/cell), h=0;
    for(var dz=-1;dz<=1;dz++) for(var dx=-1;dx<=1;dx++){
      var cx=gx+dx, cz=gz+dz;
      if(h21(cx*3+seed, cz*5+seed)>0.42) continue;
      var px=(cx+0.2+0.6*h21(cx+13+seed,cz+41+seed))*cell;
      var pz=(cz+0.2+0.6*h21(cx+71+seed,cz+29+seed))*cell;
      var t=h21(cx*7+seed+2, cz*11+seed+2), r=rMin+(rMax-rMin)*t*t;
      var d=Math.hypot(x-px,z-pz)/r; if(d>1.7) continue;
      var dep=dD*2*r;
      if(d<1) h+=dep*(d*d-1);
      var e=(d-1)/0.2; h+=dep*0.22*Math.exp(-e*e);
    }
    return h;
  }
  function craters(x,z){ return craterCell(x,z,70,4,14,0.06,0)+craterCell(x,z,240,16,46,0.05,17); }
  function detail(x,z){ return rough(x,z)+craters(x,z); }
  function apronW(x,z){ return smoothstep(SITE.apronR0,SITE.apronR1,Math.hypot(x,z)); }
  /* DEM-only height, pad-relative. THIS is what every screening number uses. */
  function heightDem(x,z){ var c=worldToCell(x,z); return sampleBil(E,c[0],c[1])-padE; }
  /* Visual / trafficability height. The apron grades out the DEM-scale relief (the site was
     prepared) but keeps most of the fine surface texture — a swept pad is still regolith, not
     a polished disc, and zeroing everything leaves a blank white oval around the lander. */
  function heightAt(x,z){ var w=apronW(x,z);
    return heightDem(x,z)*w + detail(x,z)*(0.30+0.70*w); }
  function illumAt(x,z){ var c=worldToCell(x,z); return clamp(sampleBil(IL,c[0],c[1]),0,1); }
  function sunVisAt(x,z){ var c=worldToCell(x,z); return clamp(sampleBil(VIS,c[0],c[1]),0,1); }
  function normalOf(hf,x,z,d){
    var hx=(hf(x+d,z)-hf(x-d,z))/(2*d), hz=(hf(x,z+d)-hf(x,z-d))/(2*d);
    var l=1/Math.sqrt(hx*hx+1+hz*hz);
    return [-hx*l, l, -hz*l];
  }
  function normalAt(x,z){ return normalOf(heightAt,x,z,3.0); }
  function normalDem(x,z){ return normalOf(heightDem,x,z,25.0); }
  function slopeAt(x,z){ var n=normalAt(x,z); return Math.acos(clamp(n[1],-1,1))*DEG; }
  function slopeDem(x,z){ var n=normalDem(x,z); return Math.acos(clamp(n[1],-1,1))*DEG; }
  /* radiative-equilibrium surface temperature — FACT: Stefan-Boltzmann;
     ESTIMATE: albedo/emissivity/scattered-IR floor. Reproduces PSR ~38 K, lit ~180-260 K. */
  var S_SOL=1361, ALB=0.12, EPS=0.95, SB=5.670374419e-8, SUN_EL=asset.sunElDeg*RAD;
  var T_FLOOR4=Math.pow(38,4);
  function tempFrom(n,il){
    var cosi=Math.max(n[1]*Math.sin(SUN_EL)+Math.sqrt(Math.max(n[0]*n[0]+n[2]*n[2],0))*Math.cos(SUN_EL)*0.5,0);
    return Math.pow(Math.max(S_SOL*(1-ALB)*cosi*il,0)/(EPS*SB)+T_FLOOR4,0.25);
  }
  function tempAt(x,z){ return tempFrom(normalDem(x,z), illumAt(x,z)); }
  var cx=(-padX+(N-1-padX))/2*PX, cz=(-padY+(N-1-padY))/2*PX;
  return { N:N, PX:PX, padE:padE, extent:N*PX, vis:VIS,
    cellToWorld:cellToWorld, worldToCell:worldToCell,
    heightDem:heightDem, heightAt:heightAt, illumAt:illumAt, sunVisAt:sunVisAt,
    normalAt:normalAt, normalDem:normalDem, slopeAt:slopeAt, slopeDem:slopeDem,
    tempAt:tempAt, tempFrom:tempFrom, detail:detail, apronW:apronW, rough:rough, craters:craters,
    minX:-padX*PX, maxX:(N-1-padX)*PX, minZ:-padY*PX, maxZ:(N-1-padY)*PX,
    centerX:cx, centerZ:cz, halfW:(N-1)*PX/2 };
}

/* =======================================================================================
   ORBIT — two-body numbers (FACT: vis-viva), used for the DOI/coast/PDI timeline.
   ======================================================================================= */
function visViva(r,a){ return Math.sqrt(GM_MOON*(2/r-1/a)); }
function orbVel(hKm){ return Math.sqrt(GM_MOON_KM/(1737.4+hKm))*1000; }
var ORB=(function(){
  var hC=100000, hP=15240, rC=R_MOON+hC, rP=R_MOON+hP, aT=(rC+rP)/2;
  var vC=Math.sqrt(GM_MOON/rC), vA=visViva(rC,aT), vP=visViva(rP,aT);
  return { hCirc:hC, hPeri:hP, vCirc:vC, vApo:vA, vPeri:vP, dvDOI:vC-vA,
           tCoast:Math.PI*Math.sqrt(aT*aT*aT/GM_MOON), aT:aT };
})();

/* =======================================================================================
   FLIGHT DYNAMICS
   ======================================================================================= */
var VEH={ m0:53000, dry:26000, Tmax:135120, Isp:320,   /* 3 x 45 kN chambers; ESTIMATE class */
  minThr:0.11,                       /* deep-throttle limit while lit */
  tauT:0.28,                         /* throttle response time constant, s */
  Iyy:380000,                        /* pitch inertia, kg m^2 (ESTIMATE, 53 t vehicle) */
  rcsTorque:21500,                   /* N m pitch authority (ESTIMATE) */
  rateMax:9*RAD,
  gearVh:3.0, gearVx:1.2 };          /* gear envelope. ASSUMPTION, Apollo-LM class:
                                        the LM gear was qualified to 3.05 m/s vertical
                                        and 1.22 m/s horizontal at contact. */
/* Gates. HG = high gate (start of approach), LG = low gate (start of terminal). */
var GATES={ HG:{h:2600, vx:140, vh:-24}, LG:{h:30, vx:0, vh:-2.6} };
var GUID={ kp:2.4, kd:3.1, tiltApp:62*RAD, tiltTerm:25*RAD,
  termA:0.07, termB:0.5, kh:1.0, kxPos:0.06, kxVel:0.9, vxTrim:0.6, axTrim:0.5, hUpright:18,
  qBrakeMargin:0.80,
  fBrake:0.92, fApp:0.50, tiltPlan:50*RAD };
/* Navigation. altLockAlt: radar altimeter lock (ESTIMATE). posUnaided: downrange
   knowledge from orbit determination before any fix (ESTIMATE). posAided: after the
   base beacon / terrain-relative fix (ASSUMPTION: beacon-aided 6 m 1-sigma; map-only
   TRN 40 m 1-sigma). fixAlt: where the fix becomes available. */
var NAV={ altSigma:0.9, altTau:0.12, altLockAlt:12000, imuDrift:0.0055, imuSigma:0.035,
  hOD:150, posOD:400, posAided:6, posTRN:40, fixAlt:5000, fixTau:3.0 };

function envAcc(vx,vh,h){ var r=R_MOON+h;
  return { ax:-vx*vh/r, ah:-GM_MOON/(r*r)+vx*vx/r }; }
/* ZEM/ZEV (energy-optimal two-point boundary solution, FACT): commanded total
   acceleration to reach target position and velocity in exactly tgo. */
function zemzev(s,T,tgo){ var t2=tgo*tgo;
  return [ 6*(T.x-s.x)/t2-(4*s.vx+2*T.vx)/tgo, 6*(T.h-s.h)/t2-(4*s.vh+2*T.vh)/tgo ]; }

/* Kinematic profile of a ZEM/ZEV leg: peak thrust-acceleration, peak tilt, min sink,
   delta-v. Used only to PLAN tgo and the leg length; the flight uses the same law on
   the navigated state with the plant in the loop. */
function legProfile(start,T,tgo,n){
  var s={x:start.x,h:start.h,vx:start.vx,vh:start.vh}, dt=tgo/n, mx=0, tilt=0, vhmin=0, dv=0, a0=null;
  for(var i=0;i<n;i++){ var rem=Math.max(tgo-i*dt,dt);
    var c=zemzev(s,T,rem), e=envAcc(s.vx,s.vh,s.h);
    var ax=c[0]-e.ax, ah=c[1]-e.ah, a=Math.hypot(ax,ah);
    if(!a0) a0=[ax,ah];
    if(a>mx) mx=a; var tl=Math.abs(Math.atan2(ax,ah)); if(tl>tilt) tilt=tl;
    if(s.vh<vhmin) vhmin=s.vh; dv+=a*dt;
    s.vx+=c[0]*dt; s.vh+=c[1]*dt; s.x+=s.vx*dt; s.h+=s.vh*dt; }
  return {a:mx, tilt:tilt, vhMin:vhmin, dv:dv, a0:a0, end:s};
}
/* For a given tgo, the leg length D that minimises peak thrust (golden section). */
function bestD(start,T,tgo,n){
  var lo=0.05*start.vx*tgo, hi=1.2*start.vx*tgo, gr=0.6180339887;
  function f(D){ var st={x:T.x-D,h:start.h,vx:start.vx,vh:start.vh}; return legProfile(st,T,tgo,n).a; }
  var a=lo, b=hi, c=b-gr*(b-a), d=a+gr*(b-a), fc=f(c), fd=f(d);
  for(var i=0;i<40;i++){ if(fc<fd){ b=d; d=c; fd=fc; c=b-gr*(b-a); fc=f(c); }
    else { a=c; c=d; fc=fd; d=a+gr*(b-a); fd=f(d); } }
  var D=(a+b)/2; return {D:D, prof:legProfile({x:T.x-D,h:start.h,vx:start.vx,vh:start.vh},T,tgo,n)};
}
/* Plan both powered legs once (pure function of VEH/GATES). Smallest tgo that respects
   the thrust fraction (braking near full thrust like Apollo P63; approach with headroom
   and a tilt/sink comfort limit like P64). */
function planDescent(){
  var aMax0=VEH.Tmax/VEH.m0, HG=GATES.HG, LG=GATES.LG;
  var brake=null;
  for(var tgo=380;tgo<=1400;tgo+=10){
    var r=bestD({x:0,h:ORB.hPeri,vx:ORB.vPeri,vh:0},{x:0,h:HG.h,vx:HG.vx,vh:HG.vh},tgo,80);
    if(r.prof.a<=GUID.fBrake*aMax0){ brake={tgo:tgo,D:r.D,prof:r.prof}; break; }
  }
  if(!brake) throw new Error('braking leg infeasible');
  var mHG=VEH.m0*Math.exp(-brake.prof.dv/(VEH.Isp*G0)), aMaxHG=VEH.Tmax/mHG, app=null;
  for(var t2=50;t2<=300;t2+=2){
    var r2=bestD({x:0,h:HG.h,vx:HG.vx,vh:HG.vh},{x:0,h:LG.h,vx:LG.vx,vh:LG.vh},t2,80);
    if(r2.prof.a<=GUID.fApp*aMaxHG && r2.prof.tilt<=GUID.tiltPlan && r2.prof.vhMin>=-45){
      app={tgo:t2,D:r2.D,prof:r2.prof}; break; }
  }
  if(!app) throw new Error('approach leg infeasible');
  var xHG=-app.D, xPDI=xHG-brake.D;
  return { brake:{tgo:brake.tgo, D:brake.D, x0:xPDI, dv:brake.prof.dv, aPeak:brake.prof.a,
                  pitch0:Math.atan2(brake.prof.a0[0],brake.prof.a0[1])},
           approach:{tgo:app.tgo, D:app.D, x0:xHG, dv:app.prof.dv, aPeak:app.prof.a, tilt:app.prof.tilt},
           mHG:mHG, dvTotal:brake.prof.dv+app.prof.dv,
           dvCap:VEH.Isp*G0*Math.log(VEH.m0/VEH.dry) };
}
var PLAN=planDescent();

/* at: 'PDI' (default) or 'HG'. aided: beacon-aided position fix (default true). */
function initialState(seed,opt){ opt=opt||{};
  var rng=makeRng(seed||12345), atHG=opt.at==='HG', s;
  if(atHG){ s={ x:PLAN.approach.x0, h:GATES.HG.h, vx:GATES.HG.vx, vh:GATES.HG.vh, m:PLAN.mHG,
      mode:'approach', tgo:PLAN.approach.tgo }; }
  else { s={ x:PLAN.brake.x0, h:ORB.hPeri, vx:ORB.vPeri, vh:0, m:VEH.m0,
      mode:'brake', tgo:PLAN.brake.tgo }; }
  var c=envAcc(s.vx,s.vh,s.h);
  var T=atHG?{x:0,h:GATES.LG.h,vx:GATES.LG.vx,vh:GATES.LG.vh}:{x:0,h:GATES.HG.h,vx:GATES.HG.vx,vh:GATES.HG.vh};
  var z=zemzev(s,T,s.tgo);
  s.pitch=Math.atan2(z[0]-c.ax, z[1]-c.ah); s.q=0; s.pCmd=s.pitch;
  s.thr=0; s.thrCmd=0; s.T=0; s.t=0; s.lit=false; s.landed=false;
  s.rng=rng; s.aided=(opt.aided!==false);
  /* nav state: orbit-determination errors before any fix */
  s.navBias=0; s.nvx=s.vx; s.nvh=s.vh;
  s.nh=s.h+(atHG?0:gauss(rng)*NAV.hOD);
  s.posBias=atHG?0:gauss(rng)*NAV.posOD; s.posBiasTgt=s.posBias; s.fix=atHG;
  if(atHG){ s.fix=true; s.posBias=s.posBiasTgt=gauss(rng)*(s.aided?NAV.posAided:NAV.posTRN); }
  s.nx=s.x+s.posBias;
  s.tdVh=0; s.tdVx=0; s.dv=0;
  return s;
}

/* guidance on the navigated state n={x,h,vx,vh}; returns thrust-acceleration command */
function guidanceCmd(s,n,dt){
  var aMax=VEH.Tmax/s.m, env=envAcc(n.vx,n.vh,n.h), gEff=-env.ah, ax, ah, c;
  if(s.mode==='brake'){
    s.tgo-=dt;
    if(s.tgo<=2.0 || n.h<=GATES.HG.h-200){ s.mode='approach'; s.tgo=PLAN.approach.tgo; }
  }
  if(s.mode==='brake'){
    /* The braking leg targets the HIGH GATE, which sits PLAN.approach.D short of the pad —
       not the pad itself. Targeting x=0 here arrives 7 km late and the approach leg then has
       to overshoot and fly backwards, which costs ~100 m/s. */
    c=zemzev(n,{x:PLAN.approach.x0,h:GATES.HG.h,vx:GATES.HG.vx,vh:GATES.HG.vh},Math.max(s.tgo,2));
    ax=c[0]-env.ax; ah=c[1]-env.ah;
    var a=Math.hypot(ax,ah); if(a>aMax){ ax*=aMax/a; ah*=aMax/a; }
    return {ax:ax, ah:ah, aMax:aMax, pCmd:Math.atan2(ax,ah)};
  }
  if(s.mode==='approach'){
    s.tgo-=dt;
    if(s.tgo<=1.5 || n.h<=GATES.LG.h+1.5) s.mode='terminal';
  }
  if(s.mode==='approach'){
    c=zemzev(n,{x:0,h:GATES.LG.h,vx:GATES.LG.vx,vh:GATES.LG.vh},Math.max(s.tgo,1.5));
    ax=c[0]-env.ax; ah=c[1]-env.ah;
  } else {
    /* Terminal: vertical-rate law, plus a drift trim in VELOCITY form. Close the
       remaining pad offset at no more than vxTrim, with the lateral acceleration bounded
       to axTrim so the demand always stays inside the tapered tilt authority below. A raw
       position/velocity PD here asks for more tilt than the taper allows and the loop
       overshoots — the bound is what keeps it stable all the way to contact. */
    var vhR=-clamp(GUID.termA*n.h+GUID.termB,0.7,19);
    ah=gEff+GUID.kh*(vhR-n.vh);
    /* Fade the position term out over the last metres so the vehicle arrives with the
       drift NULLED rather than still closing on the pad: below the tilt taper the
       attitude is frozen, so any trim still running at that point is simply carried into
       the gear. Real landers accept the residual miss and stop the drift. */
    var vxR=clamp(-GUID.kxPos*n.x,-GUID.vxTrim,GUID.vxTrim)*clamp((n.h-2)/8,0,1);
    ax=clamp(GUID.kxVel*(vxR-n.vx),-GUID.axTrim,GUID.axTrim);
  }
  /* Sink-rate safety cap: never let the vehicle sink faster than 85% of available net
     deceleration can arrest by h=0. (Found by dispersion analysis in v6.) */
  var aNet=Math.max(aMax-gEff,0.2), vhSafe=Math.sqrt(2*(0.85*aNet)*Math.max(n.h,0.5));
  if(n.vh<-vhSafe) ah=Math.max(ah,gEff+1.2*(-vhSafe-n.vh));
  ah=clamp(ah,0,aMax);
  var axAv=Math.sqrt(Math.max(aMax*aMax-ah*ah,0));
  ax=clamp(ax,-axAv,axAv);
  /* Vertical-authority protection. With a large lateral demand and ah near zero, atan2
     would command a near-horizontal attitude and the vehicle would free-fall — with real
     attitude inertia that is unrecoverable (found by dispersion analysis in v6).
     Two guards, in this order:
       1. WEIGHT-SUPPORT FLOOR (terminal only): never give up more than 15% of weight
          support close to the ground, so drift-nulling can never turn into a drop.
          NOTE: the floor must stay BELOW gEff — a floor set as a fraction of aMax (v6)
          exceeds local gravity on a light, high-thrust vehicle and makes it climb while
          nulling drift, which burns the terminal propellant budget.
       2. TILT CLAMP, which then bounds ax = ah*tan(pitch) and keeps thrust mostly up. */
  /* Attitude is tapered to near-vertical over the last GUID.hUpright metres: a lander
     must arrive upright on its gear, and residual drift it cannot null by then is real
     (it is what the gear envelope in the screening criteria is there to absorb). */
  var tiltMax=(s.mode==='terminal')
    ? GUID.tiltTerm*clamp(n.h/GUID.hUpright,0.04,1)
    : GUID.tiltApp;
  if(s.mode==='terminal' && Math.abs(ax)>0.05){
    ah=Math.max(ah,Math.min(0.85*gEff,aMax));
    axAv=Math.sqrt(Math.max(aMax*aMax-ah*ah,0));
    ax=clamp(ax,-axAv,axAv);
  }
  var pCmd=clamp(Math.atan2(ax,Math.max(ah,1e-6)),-tiltMax,tiltMax);
  ax=ah*Math.tan(pCmd);
  return {ax:ax, ah:ah, aMax:aMax, pCmd:pCmd};
}

/* ground: optional function(xWorld) -> terrain height under the vehicle (pad datum). */
function dynStep(s,dt,ground){
  if(s.landed) return s;
  /* ---- navigation (what the autopilot believes) ---- */
  var meas=s.h + gauss(s.rng)*NAV.altSigma*(1+s.h/1200);
  var valid=s.h<NAV.altLockAlt;
  var k=dt/(NAV.altTau+dt);
  s.nh = valid ? s.nh+(meas-s.nh)*k : s.nh + s.nvh*dt;
  s.navBias += (gauss(s.rng)*NAV.imuSigma - s.navBias*0.06)*dt;
  s.nvh = s.vh + s.navBias + gauss(s.rng)*NAV.imuDrift*10;
  s.nvx = s.vx + s.navBias*0.6;
  if(!s.fix && s.h<NAV.fixAlt){ s.fix=true;
    s.posBiasTgt=gauss(s.rng)*(s.aided?NAV.posAided:NAV.posTRN); }
  if(s.fix) s.posBias += (s.posBiasTgt-s.posBias)*(dt/(NAV.fixTau+dt));
  s.nx = s.x + s.posBias;
  /* ---- guidance on navigated state ---- */
  var cmd=guidanceCmd(s,{x:s.nx,h:s.nh,vx:s.nvx,vh:s.nvh},dt);
  var aT=Math.hypot(cmd.ax,cmd.ah);
  s.pCmd=cmd.pCmd;
  /* ---- attitude: rate command -> RCS torque -> angular accel (2nd order) ----
     The rate command is BRAKING-AWARE: q_cmd = sqrt(2*alphaMax*|e|*margin), the fastest
     rate from which the available RCS torque can still stop the slew exactly on target.
     A plain proportional law (v6) commands the full rate limit for any sizeable error,
     but this vehicle can only decelerate at alphaMax = rcsTorque/Iyy = 3.2 deg/s^2, so
     stopping a 9 deg/s slew costs ~12 deg of travel: the attitude then overshoots, the
     lateral acceleration reverses, and the terminal phase enters a limit cycle that
     leaves the lander tilted at contact. FACT: this is why real attitude autopilots use
     a parabolic (braking) switching curve rather than pure proportional rate. */
  var e=angW(cmd.pCmd-s.pitch);
  var alphaMax=VEH.rcsTorque/VEH.Iyy;
  var qMag=Math.min(Math.sqrt(2*alphaMax*Math.abs(e)*GUID.qBrakeMargin),VEH.rateMax);
  var qCmd=clamp((e>=0?qMag:-qMag)+GUID.kp*e*0.10,-VEH.rateMax,VEH.rateMax);
  var tq=clamp(GUID.kd*(qCmd-s.q)*VEH.Iyy, -VEH.rcsTorque, VEH.rcsTorque);
  s.q += (tq/VEH.Iyy)*dt;
  s.q = clamp(s.q,-VEH.rateMax,VEH.rateMax);
  s.pitch = angW(s.pitch+s.q*dt);
  /* ---- throttle: command, deep-throttle floor, first-order lag ---- */
  var fuel=s.m-VEH.dry;
  var want=clamp(aT/cmd.aMax,0,1);
  if(fuel<=0) want=0;
  else if(want>0.01) want=Math.max(want,VEH.minThr);
  s.thrCmd=want;
  s.thr += (want-s.thr)*(dt/(VEH.tauT+dt));
  s.thr = clamp(s.thr,0,1);
  s.lit = s.thr>0.02;
  s.T = s.thr*VEH.Tmax;
  /* ---- translation: thrust along the ACTUAL body attitude, curved-Moon terms ---- */
  var a=s.T/s.m, r=R_MOON+s.h;
  var ax=a*Math.sin(s.pitch)-s.vx*s.vh/r;
  var ah=a*Math.cos(s.pitch)-GM_MOON/(r*r)+s.vx*s.vx/r;
  s.vx+=ax*dt; s.vh+=ah*dt;
  s.x+=s.vx*(R_MOON/r)*dt; s.h+=s.vh*dt;
  var dm=s.T/(VEH.Isp*G0)*dt;
  s.dv+=a*dt;
  s.m=Math.max(VEH.dry, s.m-dm);
  s.t+=dt;
  var gnd=ground?ground(s.x):0;
  if(s.h<=gnd){ s.h=gnd; s.landed=true; s.mode='landed';
    s.tdVh=s.vh; s.tdVx=s.vx; s.vh=0; s.vx=0; s.thr=0; s.thrCmd=0; s.T=0; s.lit=false; }
  return s;
}
function phaseName(s){
  if(s.landed) return 'LANDED';
  if(s.mode==='brake') return 'BRAKING PHASE';
  if(s.mode==='approach') return (s.vx<GATES.HG.vx*0.25)?'VERTICAL DESCENT':'APPROACH PHASE';
  return 'TERMINAL DESCENT';
}
/* deterministic reference run (fixed seed, fixed step). Braking is integrated at dtB. */
function runDescent(seed,dt,opt){ opt=opt||{};
  dt=dt||0.02; var dtB=opt.dtBrake||0.1;
  var s=initialState(seed,opt), n=0;
  while(!s.landed && n<200000){ dynStep(s, s.mode==='brake'?dtB:dt, opt.ground); n++; }
  return { xTD:s.x, t:s.t, vh:s.tdVh, vx:s.tdVx, fuel:s.m-VEH.dry, pitch:s.pitch, dv:s.dv, m:s.m };
}

/* ---------------- Monte Carlo dispersion -> landing ellipse ---------------- */
/* Landing-site abort criteria. Slope limit is the binding constraint for a 6-leg cargo
   lander; undulation is a footpad-clearance proxy measured on the real LOLA grid.
   Values are ASSUMPTIONS (typical lander class), not a qualified GN&C spec. */
var ABORT={ slopeDeg:12,        /* ASSUMPTION: 6-leg cargo lander static limit */
            undM:5.7,            /* CALIBRATED at load — see calibrateAbort() */
            undR:120,            /* m — ~2.4 DEM pixels; smallest resolvable scale */
            padR:5.5,            /* m — footpad circle (BELOW DEM resolution) */
            vhMax:VEH.gearVh, vxMax:VEH.gearVx, fuelMin:250,
            padResolvable:false, /* footpad-scale roughness is a DATA GAP here */
            undCal:null, undMargin:1.5 };
/* Calibrate the undulation criterion to the REFERENCE PAD rather than to an invented
   number: the metric is RELATIVE — "is this touchdown point worse than the site we
   already judged acceptable?" — which is the question the ellipse can honestly support. */
function calibrateAbort(TER){
  if(!TER) return ABORT;
  ABORT.undCal=siteUndulation(TER,0,0,ABORT.undR);
  ABORT.undM=Math.max(ABORT.undCal*ABORT.undMargin,0.5);
  return ABORT;
}
/* Terrain UNDULATION: departure from the local best-fit plane at a radius the DEM can
   actually resolve (FACT: 50 m/px). Uses the DEM ONLY — synthetic relief is excluded so
   a screening number is never contaminated by cosmetic texture. */
function siteUndulation(TER,x,z,r){
  if(!TER) return 0;
  var n=12, sh=0, sxx=0, szz=0, sxz=0, sxh=0, szh=0, P=[];
  for(var i=0;i<n;i++){
    var a=i/n*Math.PI*2, dx=Math.cos(a)*r, dz=Math.sin(a)*r;
    var h=TER.heightDem(x+dx,z+dz);
    P.push([dx,dz,h]);
    sh+=h; sxx+=dx*dx; szz+=dz*dz; sxz+=dx*dz; sxh+=dx*h; szh+=dz*h;
  }
  var det=sxx*szz-sxz*sxz;
  var A2=det!==0?(sxh*szz-szh*sxz)/det:0;
  var B2=det!==0?(szh*sxx-sxh*sxz)/det:0;
  var C2=sh/n, mx=0;
  for(var j=0;j<n;j++){
    var res=Math.abs(P[j][2]-(A2*P[j][0]+B2*P[j][1]+C2));
    if(res>mx) mx=res;
  }
  return mx;
}
function siteRough(TER,x,z,r){ return siteUndulation(TER,x,z,r); }

function stat(a){ var m=a.reduce(function(p,c){return p+c;},0)/a.length;
  var v=a.reduce(function(p,c){return p+(c-m)*(c-m);},0)/a.length;
  return {mean:m, sd:Math.sqrt(v), min:Math.min.apply(null,a), max:Math.max.apply(null,a)}; }

/* Stage 1: dispersions at PDI propagated through braking to the high gate (dt 0.1). */
function brakingDispersion(n,seed){
  n=n||48; var rng=makeRng(seed||4242), X=[],H=[],VX=[],VH=[],M=[];
  for(var i=0;i<n;i++){
    var s=initialState((seed||4242)+i*7919);
    s.h+=gauss(rng)*150; s.vx+=gauss(rng)*3; s.vh+=gauss(rng)*2; s.m*=1+gauss(rng)*0.008;
    var tScale=1+gauss(rng)*0.012, saveT=VEH.Tmax; VEH.Tmax=saveT*tScale;
    var k=0; while(s.mode==='brake'&&!s.landed&&k<30000){ dynStep(s,0.1); k++; }
    VEH.Tmax=saveT;
    X.push(s.x-PLAN.approach.x0); H.push(s.h-GATES.HG.h); VX.push(s.vx-GATES.HG.vx); VH.push(s.vh-GATES.HG.vh);
    M.push(s.m-PLAN.mHG);
  }
  return { n:n, x:stat(X), h:stat(H), vx:stat(VX), vh:stat(VH), m:stat(M) };
}
/* Stage 2: approach + terminal from the dispersed high gate, screened on the real DEM. */
function monteCarlo(n,seed,TER,opt){ opt=opt||{};
  n=n||200; var rng=makeRng(seed||777), aided=(opt.aided!==false);
  var st1=opt.stage1||brakingDispersion(opt.n1||48,(seed||777)+11);
  calibrateAbort(TER);
  var xs=[], zs=[], vhs=[], vxs=[], fuels=[], slopes=[], roughs=[], cases=[];
  var hard=0, nSafe=0;
  var cause={slope:0, rough:0, vh:0, vx:0, fuel:0, shadow:0};
  for(var i=0;i<n;i++){
    var s=initialState((seed||777)+i*7919,{at:'HG',aided:aided});
    s.x+=gauss(rng)*st1.x.sd+st1.x.mean; s.h+=gauss(rng)*st1.h.sd+st1.h.mean;
    s.vx+=gauss(rng)*st1.vx.sd+st1.vx.mean; s.vh+=gauss(rng)*st1.vh.sd+st1.vh.mean;
    s.m+=gauss(rng)*st1.m.sd+st1.m.mean; s.nh=s.h;
    var tScale=1+gauss(rng)*0.012, saveT=VEH.Tmax; VEH.Tmax=saveT*tScale;
    var k=0; while(!s.landed && k<20000){ dynStep(s,0.04); k++; }
    VEH.Tmax=saveT;
    /* Crossrange: the 2-DOF solver is planar, so lateral nav error is applied as an
       independent term with the same 1-sigma as downrange. ASSUMPTION. */
    var zTD=gauss(rng)*(aided?NAV.posAided:NAV.posTRN);
    var xTD=s.x, fuel=s.m-VEH.dry;
    var slope=TER?TER.slopeDem(xTD,zTD):0;
    var rough=siteUndulation(TER,xTD,zTD,ABORT.undR);
    var ill  =TER&&TER.illumAt?TER.illumAt(xTD,zTD):1;
    var why=[];
    if(slope>ABORT.slopeDeg)        { why.push('slope');  cause.slope++; }
    if(rough>ABORT.undM)            { why.push('undul');  cause.rough++; }
    if(Math.abs(s.tdVh)>ABORT.vhMax){ why.push('vh');     cause.vh++;    }
    if(Math.abs(s.tdVx)>ABORT.vxMax){ why.push('vx');     cause.vx++;    }
    if(fuel<ABORT.fuelMin)          { why.push('fuel');   cause.fuel++;  }
    if(ill<0.02)                    { why.push('shadow'); cause.shadow++;}
    var ok=why.length===0;
    if(ok) nSafe++;
    if(Math.abs(s.tdVh)>ABORT.vhMax||Math.abs(s.tdVx)>ABORT.vxMax) hard++;
    xs.push(xTD); zs.push(zTD); vhs.push(s.tdVh); vxs.push(s.tdVx);
    fuels.push(fuel); slopes.push(slope); roughs.push(rough);
    cases.push({x:xTD,z:zTD,slope:slope,rough:rough,ok:ok,why:why});
  }
  var domK=null, domV=0;
  for(var c in cause) if(cause[c]>domV){ domV=cause[c]; domK=c; }
  return { n:n, aided:aided, stage1:st1, x:stat(xs), z:stat(zs), vh:stat(vhs), vx:stat(vxs), fuel:stat(fuels),
           slope:stat(slopes), rough:stat(roughs),
           hardFrac:hard/n, safeFrac:nSafe/n, cause:cause,
           dom:(domV>0?domK:null), domN:domV, cases:cases, crit:ABORT };
}

/* ---------------- ROVER + real-DEM route ---------------- */
var ROVER={ vMax:3.0, acc:1.1, brake:2.2, yawRate:0.95, wheelR:0.34, clear:0.62,
  gradeStop:22, lampI:0.10 };        /* lampI: headlight radiant intensity, sun-irradiance units at 1 m (ESTIMATE) */
function roverInit(x,z,hdg){ return {x:x,z:z,hdg:hdg||0,v:0,spin:0,wp:0,hold:0,odo:0,pitch:0,roll:0}; }
function buildRoute(asset,TER){
  var out=[], r=asset.route||[], i;
  for(i=0;i<r.length;i++){
    var w=TER.cellToWorld(r[i][0],r[i][1]);
    out.push({x:w[0], z:w[1], note:null, hold:0});
  }
  if(!out.length) return out;
  out[0].note='Egress — clear of the lander';
  var mid=Math.floor(out.length/2);
  if(out[mid]) out[mid].note='Descending the wall into shadow';
  out[out.length-1].note='Arrived — permanently shadowed crater floor';
  out[out.length-1].hold=3;
  /* The A* route delivers the rover to the PSR; the candidate cold traps are spread across
     the crater floor beyond it, so append a nearest-neighbour survey pattern that actually
     drives to each one. Without this the traverse ends ~900 m short of the nearest target
     and nothing is ever logged. */
  var ICE=buildIce(asset,TER);
  var cur={x:out[out.length-1].x, z:out[out.length-1].z}, left=ICE.slice();
  while(left.length){
    var bi=0, bd=Infinity;
    for(i=0;i<left.length;i++){
      var dd=Math.hypot(left[i].x-cur.x,left[i].z-cur.z);
      if(dd<bd){ bd=dd; bi=i; }
    }
    var c=left.splice(bi,1)[0];
    out.push({x:c.x, z:c.z, hold:3, note:'Survey station '+c.id+' — '+c.T.toFixed(0)+' K'});
    cur=c;
  }
  out[out.length-1].hold=4;
  out[out.length-1].park=true;
  out[out.length-1].note='Final survey station — traverse complete';
  return out;
}
function roverStep(r,dt,cmd,TER){
  var thr=clamp(cmd.thr,-1,1), steer=clamp(cmd.steer,-1,1);
  /* grade limits speed: climbing costs, steep descent is braked */
  var ch=Math.cos(r.hdg), sh=Math.sin(r.hdg);
  var gA=TER.heightAt(r.x,r.z), gB=TER.heightAt(r.x+ch*4,r.z+sh*4);
  var grade=Math.atan2(gB-gA,4)*DEG;
  var gFac=clamp(1-Math.abs(grade)/ROVER.gradeStop,0.15,1);
  var vT=thr*ROVER.vMax*gFac;
  var dv=vT-r.v, rate=(Math.abs(vT)<Math.abs(r.v))?ROVER.brake:ROVER.acc;
  r.v+=clamp(dv,-rate*dt,rate*dt);
  r.hdg=angW(r.hdg+steer*ROVER.yawRate*dt*clamp(Math.abs(r.v)/1.0+0.25,0,1));
  var dx=Math.cos(r.hdg)*r.v*dt, dz=Math.sin(r.hdg)*r.v*dt;
  r.x+=dx; r.z+=dz; r.odo+=Math.abs(r.v)*dt;
  r.x=clamp(r.x,TER.minX+60,TER.maxX-60); r.z=clamp(r.z,TER.minZ+60,TER.maxZ-60);
  r.spin+=r.v/ROVER.wheelR*dt;
  r.grade=grade;
  return r;
}
function autoDrive(r,dt,ROUTE){
  if(r.wp>=ROUTE.length) return {thr:0,steer:0,done:true};
  var w=ROUTE[r.wp], dx=w.x-r.x, dz=w.z-r.z, dist=Math.hypot(dx,dz);
  if(dist<14){
    if(r.hold<(w.hold||0)){ r.hold+=dt; return {thr:0,steer:0,at:w}; }
    r.hold=0; r.wp++; return {thr:0,steer:0,reached:w};
  }
  var want=Math.atan2(dz,dx), err=angW(want-r.hdg);
  var steer=clamp(err*1.5,-1,1);
  var thr=clamp(dist/25,0.3,1)*clamp(1.15-Math.abs(err)*1.1,0.1,1);
  return {thr:thr,steer:steer};
}
/* ---------------- ice / cold-trap targets ----------------
   Positions are DERIVED: deepest cells of the connected permanently-shadowed region
   the route terminates in, from real LOLA topography + modelled illumination.
   LABEL: candidate cold traps consistent with water-ice stability (T < ~110 K).
   This is NOT a measured ice detection — no neutron/UV/radar data is used. */
function buildIce(asset,TER){
  var out=[];
  for(var i=0;i<asset.ice.length;i++){
    var c=asset.ice[i], w=TER.cellToWorld(c.x,c.y);
    out.push({ x:w[0], z:w[1], r:c.r||220, T:c.T, elev:c.elev, ill:c.ill,
      id:'CT-'+(i+1), s:clamp(1.0-(c.T-38)/60,0.45,1.0) });
  }
  return out;
}
function scanTargets(rx,rz,ice){
  var total=0, best=null;
  for(var i=0;i<ice.length;i++){ var d=ice[i];
    var dist=Math.hypot(rx-d.x,rz-d.z);
    var sig=d.s*Math.exp(-(dist*dist)/(2*Math.pow(d.r,2)));
    total+=sig;
    if(!best||dist<best.dist) best={dep:d,dist:dist,sig:sig,idx:i};
  }
  return {total:clamp(total,0,1), best:best};
}
/* ---------------- ramp ---------------- */
var RAMP={ closedDeg:-80, openDeg:17.2, dur:9, hinge:[3.9,2.0,0], len:6.9, w:3.3 };
function rampAngle(u){ u=clamp(u,0,1); var s=u*u*(3-2*u);
  return (RAMP.closedDeg+(RAMP.openDeg-RAMP.closedDeg)*s)*RAD; }

/* ---------------- plume / dust interaction (parameters for the cosmetic layer) ----------------
   FACT (Apollo, Chang'e observations): in vacuum the exhaust erodes a sheet of regolith
   that leaves at grazing angles (a few degrees) and tens of m/s; it does not billow.
   Onset altitude scales with thrust; ESTIMATE for a 3 x 45 kN cluster. */
var DUST={ hOnset:60, angMin:1.0*RAD, angMax:6.0*RAD, vMin:18, vMax:70, rate:900, life:[1.0,2.4] };

/* ---------------- mesh generators ---------------- */
function quatAxisAngle(x,y,z,a){ var s=Math.sin(a/2), l=Math.sqrt(x*x+y*y+z*z)||1;
  return [x/l*s,y/l*s,z/l*s,Math.cos(a/2)]; }
function quatMul(a,b){ return [
  a[3]*b[0]+a[0]*b[3]+a[1]*b[2]-a[2]*b[1],
  a[3]*b[1]-a[0]*b[2]+a[1]*b[3]+a[2]*b[0],
  a[3]*b[2]+a[0]*b[1]-a[1]*b[0]+a[2]*b[3],
  a[3]*b[3]-a[0]*b[0]-a[1]*b[1]-a[2]*b[2]]; }
function quatYTo(d){ var l=Math.sqrt(d[0]*d[0]+d[1]*d[1]+d[2]*d[2])||1;
  d=[d[0]/l,d[1]/l,d[2]/l];
  var dot=clamp(d[1],-1,1);
  if(dot>0.99995) return [0,0,0,1];
  if(dot<-0.99995) return [1,0,0,0];
  var ax=d[2], ay=0, az=-d[0];                        /* cross([0,1,0],d) */
  var al=Math.sqrt(ax*ax+az*az)||1;
  return quatAxisAngle(ax/al,0,az/al,Math.acos(dot));
}
function quatToMat3(q){ var x=q[0],y=q[1],z=q[2],w=q[3];
  return [1-2*(y*y+z*z),2*(x*y+z*w),2*(x*z-y*w),
          2*(x*y-z*w),1-2*(x*x+z*z),2*(y*z+x*w),
          2*(x*z+y*w),2*(y*z-x*w),1-2*(x*x+y*y)]; }
function gBox(w,h,d){ var x=w/2,y=h/2,z=d/2;
  var F=[[ 1,0,0],[-1,0,0],[0, 1,0],[0,-1,0],[0,0, 1],[0,0,-1]];
  var P=[],N=[],I=[],vi=0;
  for(var f=0;f<6;f++){ var n=F[f],u,v;
    if(Math.abs(n[0])===1){ u=[0,1,0]; v=[0,0,n[0]]; }
    else if(Math.abs(n[1])===1){ u=[1,0,0]; v=[0,0,-n[1]]; }
    else { u=[n[2],0,0]; v=[0,1,0]; }
    var c=[n[0]*x,n[1]*y,n[2]*z], su=[u[0]*x,u[1]*y,u[2]*z], sv=[v[0]*x,v[1]*y,v[2]*z];
    var q=[[-1,-1],[1,-1],[1,1],[-1,1]];
    for(var k2=0;k2<4;k2++){ P.push(c[0]+q[k2][0]*su[0]+q[k2][1]*sv[0],
      c[1]+q[k2][0]*su[1]+q[k2][1]*sv[1], c[2]+q[k2][0]*su[2]+q[k2][1]*sv[2]);
      N.push(n[0],n[1],n[2]); }
    I.push(vi,vi+1,vi+2, vi,vi+2,vi+3); vi+=4;
  }
  return {P:new Float32Array(P),N:new Float32Array(N),I:new Uint16Array(I)};
}
function gCyl(r0,r1,h,seg){ var P=[],N=[],I=[],i;
  for(i=0;i<=seg;i++){ var a=i/seg*Math.PI*2, c=Math.cos(a), s=Math.sin(a);
    var slope=(r0-r1)/h, nl=1/Math.sqrt(1+slope*slope);
    P.push(c*r1,h/2,s*r1); N.push(c*nl,slope*nl,s*nl);
    P.push(c*r0,-h/2,s*r0); N.push(c*nl,slope*nl,s*nl); }
  for(i=0;i<seg;i++){ var a2=i*2;
    I.push(a2,a2+1,a2+2, a2+1,a2+3,a2+2); }
  var ci=P.length/3;
  P.push(0,h/2,0); N.push(0,1,0);
  for(i=0;i<=seg;i++){ var a3=i/seg*Math.PI*2;
    P.push(Math.cos(a3)*r1,h/2,Math.sin(a3)*r1); N.push(0,1,0); }
  for(i=0;i<seg;i++) I.push(ci,ci+1+i,ci+2+i);
  var c2=P.length/3;
  P.push(0,-h/2,0); N.push(0,-1,0);
  for(i=0;i<=seg;i++){ var a4=i/seg*Math.PI*2;
    P.push(Math.cos(a4)*r0,-h/2,Math.sin(a4)*r0); N.push(0,-1,0); }
  for(i=0;i<seg;i++) I.push(c2,c2+2+i,c2+1+i);
  return {P:new Float32Array(P),N:new Float32Array(N),I:new Uint16Array(I)};
}
function gSphere(r,seg,hemY){ var P=[],N=[],I=[],i,j;
  var jn=seg, inn=seg*2;
  for(j=0;j<=jn;j++){ var ph=(hemY? j/jn*Math.PI/2 : j/jn*Math.PI);
    for(i=0;i<=inn;i++){ var th=i/inn*Math.PI*2;
      var nx=Math.sin(ph)*Math.cos(th), ny=Math.cos(ph), nz=Math.sin(ph)*Math.sin(th);
      P.push(nx*r,ny*r,nz*r); N.push(nx,ny,nz); } }
  for(j=0;j<jn;j++) for(i=0;i<inn;i++){ var a=j*(inn+1)+i, b=a+inn+1;
    I.push(a,b,a+1, a+1,b,b+1); }
  return {P:new Float32Array(P),N:new Float32Array(N),
    I:(P.length/3>65000)?new Uint32Array(I):new Uint16Array(I)};
}
function strut(x0,y0,z0,x1,y1,z1,r){
  var d=[x1-x0,y1-y0,z1-z0], len=Math.hypot(d[0],d[1],d[2]);
  return { geo:gCyl(r,r,len,6), q:quatYTo(d), t:[(x0+x1)/2,(y0+y1)/2,(z0+z1)/2] };
}
/* Linear-space albedos (sRGB decoded). */
var COL={ hull:[0.62,0.62,0.66], foil:[0.75,0.46,0.09], dark:[0.025,0.027,0.035],
  leg:[0.36,0.37,0.42], bell:[0.09,0.09,0.11], white:[0.83,0.83,0.86],
  tank:[0.55,0.56,0.60], red:[0.48,0.03,0.02], hab:[0.76,0.74,0.66],
  panel:[0.010,0.022,0.09], rov:[0.60,0.60,0.66], lamp:[1.0,0.94,0.72],
  crate:[0.48,0.30,0.07], beacon:[0.05,1.0,0.25], rtg:[0.10,0.11,0.13], padLt:[1.0,0.62,0.2] };
function part(geo,q,t,color,opt){ var p={geo:geo,q:q||[0,0,0,1],t:t||[0,0,0],color:color};
  if(opt) for(var k in opt) p[k]=opt[k];
  return p; }

/* ---------------- CARGO SHIP (~90 parts). Pads rest at local y=0. ---------------- */
function buildCargoShip(){
  var P=[], i;
  var legH=2.05, deckY=legH+1.1;                     /* deck platform center */
  for(i=0;i<8;i++){ var a=i/8*Math.PI*2+Math.PI/16;
    P.push(part(gBox(4.6,1.05,3.85), quatAxisAngle(0,1,0,a),
      [Math.cos(a)*2.55,deckY,Math.sin(a)*2.55], COL.hull, {metal:0.55,rough:0.45})); }
  P.push(part(gBox(5.6,1.05,5.6),[0,0,0,1],[0,deckY,0],COL.hull,{metal:0.55,rough:0.45}));
  /* gold foil skirt (MLI) */
  P.push(part(gCyl(5.35,4.85,1.35,20),[0,0,0,1],[0,deckY-1.05,0],COL.foil,{metal:0.85,rough:0.35,foil:1}));
  /* cargo module + bay */
  P.push(part(gBox(7.6,3.5,4.9),[0,0,0,1],[-0.6,deckY+2.35,0],COL.white,{metal:0.0,rough:0.55}));
  P.push(part(gBox(0.35,3.1,3.45),[0,0,0,1],[3.35,deckY+2.2,0],COL.dark,{metal:0.2,rough:0.8}));
  /* floodlight bar above bay */
  P.push(part(gBox(0.5,0.28,3.0),[0,0,0,1],[3.45,deckY+4.0,0],COL.lamp,{emis:0.0,flood:1,tk:300}));
  /* RAMP — dynamic part; hinge/hierarchy handled at render. */
  P.push(part(gBox(RAMP.len,0.22,RAMP.w),[0,0,0,1],[0,0,0],COL.leg,{ramp:1,metal:0.7,rough:0.5}));
  /* crew cabin dome + windows */
  P.push(part(gSphere(1.7,10,true),[0,0,0,1],[-2.6,deckY+4.1,0],COL.white,{metal:0.0,rough:0.5}));
  P.push(part(gBox(0.16,0.5,1.5),[0,0,0,1],[-1.0,deckY+4.35,0],COL.dark,{metal:0.1,rough:0.12}));
  /* side tanks */
  P.push(part(gSphere(1.35,10,false),[0,0,0,1],[0.3,deckY+1.9, 3.05],COL.tank,{metal:0.9,rough:0.28}));
  P.push(part(gSphere(1.35,10,false),[0,0,0,1],[0.3,deckY+1.9,-3.05],COL.tank,{metal:0.9,rough:0.28}));
  /* 3 engine bells */
  var be=[[0,0],[ -1.85,1.55],[-1.85,-1.55]];
  for(i=0;i<3;i++){ P.push(part(gCyl(1.05,0.42,1.5,14),[0,0,0,1],
    [be[i][0],deckY-2.0,be[i][1]],COL.bell,{metal:0.8,rough:0.4,eng:1})); }
  /* 6 legs */
  for(i=0;i<6;i++){ var la=i/6*Math.PI*2+Math.PI/6;
    var lx=Math.cos(la)*4.4, lz=Math.sin(la)*4.4;
    var hx=Math.cos(la)*6.3, hz=Math.sin(la)*6.3;
    var s1=strut(lx*0.72,deckY-0.5,lz*0.72,hx,0.35,hz,0.17);
    P.push(part(s1.geo,s1.q,s1.t,COL.leg,{metal:0.7,rough:0.4}));
    var s2=strut(lx*0.95,deckY-1.35,lz*0.95,hx*0.94,0.5,hz*0.94,0.10);
    P.push(part(s2.geo,s2.q,s2.t,COL.leg,{metal:0.7,rough:0.4}));
    P.push(part(gCyl(0.72,0.5,0.3,10),[0,0,0,1],[hx,0.16,hz],COL.dark,{metal:0.3,rough:0.8}));
  }
  /* comms */
  P.push(part(gCyl(0.05,0.05,3.2,6),[0,0,0,1],[-3.4,deckY+6.2,1.6],COL.white,{metal:0.4,rough:0.5}));
  P.push(part(gSphere(0.85,8,true),quatAxisAngle(1,0,0,1.15),[-3.3,deckY+5.3,-1.8],COL.white,{metal:0.0,rough:0.45}));
  /* RCS quads */
  for(i=0;i<4;i++){ var ra=i/4*Math.PI*2+Math.PI/4;
    P.push(part(gBox(0.5,0.5,0.5),[0,0,0,1],
      [Math.cos(ra)*4.15,deckY+3.3,Math.sin(ra)*4.15],COL.dark,{metal:0.4,rough:0.6})); }
  /* red hab stripe */
  P.push(part(gBox(7.62,0.3,4.92),[0,0,0,1],[-0.6,deckY+3.6,0],COL.red,{metal:0.0,rough:0.6}));
  return P;
}

/* ---------------- ROVER (~40 parts) — origin at ground contact under CG ------------- */
function buildRover(){
  var P=[], i;
  var cy=ROVER.clear+0.28;
  P.push(part(gBox(2.5,0.5,1.5),[0,0,0,1],[0,cy,0],COL.rov,{metal:0.5,rough:0.5}));
  P.push(part(gBox(1.5,0.34,1.2),[0,0,0,1],[-0.2,cy+0.42,0],COL.foil,{metal:0.85,rough:0.4,foil:1}));
  /* solar deck */
  P.push(part(gBox(1.9,0.06,1.42),[0,0,0,1],[-0.25,cy+0.66,0],COL.panel,{metal:0.0,rough:0.15}));
  var wx=[-0.95,0,0.95];
  for(i=0;i<6;i++){ var side=(i<3)?1:-1, xw=wx[i%3];
    P.push(part(gCyl(ROVER.wheelR,ROVER.wheelR,0.30,12),
      quatAxisAngle(1,0,0,Math.PI/2),[xw,ROVER.wheelR,side*0.92],COL.dark,
      {wheel:1,axle:[xw,ROVER.wheelR,side*0.92],metal:0.2,rough:0.9}));
    var rk=strut(xw*0.7,cy-0.1,side*0.45,xw,ROVER.wheelR+0.08,side*0.86,0.055);
    P.push(part(rk.geo,rk.q,rk.t,COL.leg,{metal:0.7,rough:0.45}));
  }
  /* mast + sensor head + headlights */
  P.push(part(gCyl(0.06,0.06,1.05,8),[0,0,0,1],[0.95,cy+0.75,0],COL.leg,{metal:0.7,rough:0.5}));
  P.push(part(gBox(0.5,0.3,0.62),[0,0,0,1],[0.98,cy+1.35,0],COL.rov,{metal:0.4,rough:0.5}));
  P.push(part(gBox(0.1,0.14,0.5),[0,0,0,1],[1.24,cy+1.35,0],COL.dark,{metal:0.1,rough:0.2}));
  P.push(part(gCyl(0.09,0.11,0.12,10),quatAxisAngle(0,0,1,Math.PI/2),[1.30,cy+0.42, 0.52],COL.lamp,{lampL:1,emis:0}));
  P.push(part(gCyl(0.09,0.11,0.12,10),quatAxisAngle(0,0,1,Math.PI/2),[1.30,cy+0.42,-0.52],COL.lamp,{lampR:1,emis:0}));
  P.push(part(gBox(0.16,0.16,1.2),[0,0,0,1],[1.22,cy+0.42,0],COL.leg,{metal:0.7,rough:0.5}));
  /* RTG — warm in thermal (FACT: RTGs run hot; value is representative) */
  P.push(part(gCyl(0.22,0.22,0.8,10),quatAxisAngle(0,0,1,Math.PI/2),[-1.35,cy+0.3,0],COL.rtg,{tk:460,metal:0.6,rough:0.5}));
  for(i=0;i<5;i++) P.push(part(gBox(0.02,0.5,0.5),[0,0,0,1],[-1.35+ (i-2)*0.14, cy+0.3,0],COL.dark,{tk:430,metal:0.4,rough:0.6}));
  /* antenna */
  P.push(part(gCyl(0.03,0.03,1.3,6),[0,0,0,1],[-0.7,cy+1.15,-0.45],COL.white,{metal:0.4,rough:0.4}));
  P.push(part(gSphere(0.3,7,true),quatAxisAngle(1,0,0,0.9),[-0.7,cy+1.7,-0.45],COL.white,{metal:0.0,rough:0.4}));
  return P;
}

/* ---------------- BASE + SUPPLIES (static, pre-positioned on the graded apron) ---------------- */
var BASE_AT=[62,0];
function buildBase(){
  var P=[], i;
  function W(px,pz){ return [BASE_AT[0]+px, 0, BASE_AT[1]+pz]; }
  var h1=W(0,-6), h2=W(0,6);
  P.push(part(gCyl(2.2,2.2,7.5,16),quatAxisAngle(0,0,1,Math.PI/2),[h1[0],2.35,h1[2]],COL.hab,{metal:0.0,rough:0.6,tk:295}));
  P.push(part(gCyl(2.2,2.2,7.5,16),quatAxisAngle(0,0,1,Math.PI/2),[h2[0],2.35,h2[2]],COL.hab,{metal:0.0,rough:0.6,tk:295}));
  P.push(part(gCyl(1.1,1.1,5.0,12),quatAxisAngle(1,0,0,Math.PI/2),[h1[0],2.1,0+BASE_AT[1]],COL.hab,{metal:0.0,rough:0.6,tk:290}));
  /* airlock + door light */
  P.push(part(gBox(2.2,2.6,2.2),[0,0,0,1],[h1[0]-4.6,1.35,h1[2]],COL.white,{metal:0.0,rough:0.55,tk:285}));
  P.push(part(gBox(0.1,0.7,0.7),[0,0,0,1],[h1[0]-5.75,1.45,h1[2]],COL.lamp,{emis:0.02,tk:285}));
  /* solar arrays (tilted towards the low sun) */
  for(i=0;i<2;i++){ var sz=W(6.5, -10+ i*20);
    P.push(part(gCyl(0.12,0.12,2.6,8),[0,0,0,1],[sz[0],1.3,sz[2]],COL.leg,{metal:0.7,rough:0.5}));
    P.push(part(gBox(6.5,0.1,3.4),quatAxisAngle(0,0,1,-1.35),[sz[0],4.1,sz[2]],COL.panel,{metal:0.0,rough:0.15})); }
  /* comm dish */
  var cd=W(3.5,12.5);
  P.push(part(gCyl(0.15,0.15,3.6,8),[0,0,0,1],[cd[0],1.8,cd[2]],COL.leg,{metal:0.7,rough:0.5}));
  P.push(part(gSphere(1.5,9,true),quatAxisAngle(1,0,0,1.2),[cd[0],4.0,cd[2]],COL.white,{metal:0.0,rough:0.45}));
  /* supply pallets — 4 stacks of crates */
  var px=[34,37.5,34.6,38.2], pz=[6,5,9.4,9.0];
  for(i=0;i<4;i++){
    P.push(part(gBox(2.4,0.25,2.4),[0,0,0,1],[px[i],0.15,pz[i]],COL.leg,{metal:0.7,rough:0.6}));
    P.push(part(gBox(1.9,1.2,1.9),[0,0,0,1],[px[i],0.95,pz[i]],COL.crate,{metal:0.0,rough:0.85,tk:150}));
    if(i%2===0) P.push(part(gBox(1.4,0.9,1.4),[0,0,0,1],[px[i],2.0,pz[i]],COL.crate,{metal:0.0,rough:0.85,tk:150}));
  }
  /* nav beacon (the aided-navigation fix source) */
  P.push(part(gCyl(0.08,0.08,2.6,8),[0,0,0,1],[24,1.3,-8],COL.leg,{metal:0.7,rough:0.5}));
  P.push(part(gSphere(0.22,7,false),[0,0,0,1],[24,2.8,-8],COL.beacon,{emis:0.03,beacon:1,tk:280}));
  /* pad edge markers (4), on the graded apron */
  for(i=0;i<4;i++){ var pa=i/4*Math.PI*2+Math.PI/4;
    P.push(part(gCyl(0.16,0.16,0.5,8),[0,0,0,1],[Math.cos(pa)*15,0.25,Math.sin(pa)*15],COL.leg,{metal:0.6,rough:0.5}));
    P.push(part(gSphere(0.13,6,false),[0,0,0,1],[Math.cos(pa)*15,0.58,Math.sin(pa)*15],COL.padLt,{emis:0.02,padLt:1,tk:270})); }
  return P;
}

/* ---------------- ring buffer + fmt ---------------- */
function makeRing(cap){ var buf=[];
  return { push:function(v){ buf.push(v); if(buf.length>cap) buf.shift(); },
    get:function(){ return buf; } }; }
function fmtMET(t){ var neg=t<0; t=Math.abs(t);
  var m=Math.floor(t/60), s=Math.floor(t%60);
  return (neg?'-':'+')+'T '+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0'); }

var API={ G_MOON:G_MOON, G0:G0, GM_MOON:GM_MOON, R_MOON:R_MOON, VEH:VEH, GATES:GATES, GUID:GUID, NAV:NAV,
  ORB:ORB, PLAN:PLAN, ROVER:ROVER, RAMP:RAMP, DUST:DUST, COL:COL, SITE:SITE, DEG:DEG, RAD:RAD, BASE_AT:BASE_AT,
  clamp:clamp, smoothstep:smoothstep, makeRng:makeRng, gauss:gauss, angW:angW,
  b64bytes:b64bytes, inflate:inflate, decodeDEM:decodeDEM, makeTerrain:makeTerrain, sunVisibility:sunVisibility,
  visViva:visViva, orbVel:orbVel, envAcc:envAcc, zemzev:zemzev, legProfile:legProfile, planDescent:planDescent,
  siteRough:siteRough, siteUndulation:siteUndulation, ABORT:ABORT, calibrateAbort:calibrateAbort,
  initialState:initialState, dynStep:dynStep, guidanceCmd:guidanceCmd, phaseName:phaseName,
  runDescent:runDescent, brakingDispersion:brakingDispersion, monteCarlo:monteCarlo,
  roverInit:roverInit, roverStep:roverStep, autoDrive:autoDrive, buildRoute:buildRoute,
  buildIce:buildIce, scanTargets:scanTargets, rampAngle:rampAngle,
  quatAxisAngle:quatAxisAngle, quatMul:quatMul, quatYTo:quatYTo, quatToMat3:quatToMat3,
  gBox:gBox, gCyl:gCyl, gSphere:gSphere, strut:strut, part:part,
  buildCargoShip:buildCargoShip, buildRover:buildRover, buildBase:buildBase,
  makeRing:makeRing, fmtMET:fmtMET };
if(typeof window!=='undefined') window.__L7__=API;
if(typeof module!=='undefined' && module.exports) module.exports=API;
