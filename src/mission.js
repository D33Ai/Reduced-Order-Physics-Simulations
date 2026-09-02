"use strict";
/* =======================================================================================
   D33 LUNAR CARGO MISSION v7 "COLDWATER" — MISSION DRIVER
   Fixed-step deterministic physics, cameras, HUD, and the frame loop.
   ======================================================================================= */
(function(){
if(typeof document==='undefined') return;
var A=window.__L7__, GFX=window.__GFX__;
var $=function(id){ return document.getElementById(id); };
var cv=$('gl'); if(!cv) return;
var DEG=A.DEG, RAD=A.RAD, clamp=A.clamp;
var VERSION='v7.0 COLDWATER';

/* ---------- mat4 ---------- */
function mMul(a,b){ var o=new Array(16);
  for(var c=0;c<4;c++) for(var r=0;r<4;r++){ var s=0;
    for(var k=0;k<4;k++) s+=a[k*4+r]*b[c*4+k]; o[c*4+r]=s; } return o; }
function mPersp(f0,asp,n,f){ var t=1/Math.tan(f0/2), nf=1/(n-f);
  return [t/asp,0,0,0, 0,t,0,0, 0,0,(f+n)*nf,-1, 0,0,2*f*n*nf,0]; }
function mOrtho(l,r,b,t,n,f){
  return [2/(r-l),0,0,0, 0,2/(t-b),0,0, 0,0,-2/(f-n),0,
    -(r+l)/(r-l),-(t+b)/(t-b),-(f+n)/(f-n),1]; }
function vSub(a,b){ return [a[0]-b[0],a[1]-b[1],a[2]-b[2]]; }
function vAdd(a,b){ return [a[0]+b[0],a[1]+b[1],a[2]+b[2]]; }
function vCross(a,b){ return [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]]; }
function vNorm(a){ var l=Math.sqrt(a[0]*a[0]+a[1]*a[1]+a[2]*a[2])||1; return [a[0]/l,a[1]/l,a[2]/l]; }
function vScale(a,s){ return [a[0]*s,a[1]*s,a[2]*s]; }
function mLookAt(e,t,u){ var z=vNorm(vSub(e,t)), x=vNorm(vCross(u,z)), y=vCross(z,x);
  return [x[0],y[0],z[0],0, x[1],y[1],z[1],0, x[2],y[2],z[2],0,
    -(x[0]*e[0]+x[1]*e[1]+x[2]*e[2]), -(y[0]*e[0]+y[1]*e[1]+y[2]*e[2]), -(z[0]*e[0]+z[1]*e[1]+z[2]*e[2]),1]; }
function mFromQT(q,t){ var R=A.quatToMat3(q);
  return [R[0],R[1],R[2],0, R[3],R[4],R[5],0, R[6],R[7],R[8],0, t[0],t[1],t[2],1]; }
function mScale(m,s){ var o=m.slice(); for(var i=0;i<3;i++){ o[i]*=s; o[4+i]*=s; o[8+i]*=s; } return o; }
function xfp(m,p){ return [m[0]*p[0]+m[4]*p[1]+m[8]*p[2]+m[12],
  m[1]*p[0]+m[5]*p[1]+m[9]*p[2]+m[13], m[2]*p[0]+m[6]*p[1]+m[10]*p[2]+m[14]]; }
function xfd(m,p){ return [m[0]*p[0]+m[4]*p[1]+m[8]*p[2],
  m[1]*p[0]+m[5]*p[1]+m[9]*p[2], m[2]*p[0]+m[6]*p[1]+m[10]*p[2]]; }
function lerp3(a,b,k){ return [a[0]+(b[0]-a[0])*k,a[1]+(b[1]-a[1])*k,a[2]+(b[2]-a[2])*k]; }
function smoo(u){ u=clamp(u,0,1); return u*u*(3-2*u); }

/* ---------- GL ---------- */
var Q=GFX.isMobile?GFX.QUAL.MED:GFX.QUAL.HIGH;
var autoQual=true;
var gl=GFX.init(cv,Q);
if(!gl){ window.showFatal('WebGL2 unavailable. Use Chrome/Edge/Firefox/Safari 15+ on a device with WebGL2.'); return; }
var ctxLost=false;

/* ---------- world / scene state ---------- */
var R_MOON=A.R_MOON;
var SUN=null, SUN_EL=0, SUN_IRR=1.0;
var EARTHSHINE=2.5e-4;      /* ESTIMATE: full-Earth irradiance at the Moon relative to the Sun.
                               Small, but in a permanently shadowed crater it is all there is. */
var TER=null, ASSET=null, ROUTE=null, ICE=null, DEMTEX=null, MC=null, MC_TRN=null;
var GRID=null, STARS=null, DISC=null, DUST=null;
var shipV=null, rovV=null, baseV=null, vPlume=null;
var MESHSTAT={tris:0};

var PH_ORB=0,PH_DOI=1,PH_COAST=2,PH_DESC=3,PH_RAMP=4,PH_EG=5,PH_EXP=6,PH_DONE=7;
var PHN=['LUNAR ORBIT','DEORBIT BURN','COAST TO PDI','POWERED DESCENT','CARGO BAY',
         'ROVER EGRESS','SURFACE OPS','SURVEY COMPLETE'];
var T_ORB=13, T_DOI=null, T_COASTVIEW=11;
var SEED=20260718;
var GMET=0, S=null, MET=0, warp=1, autoWarp=true, paused=true, started=false;
var camMode=0, vision=0, lampOn=0, lampAuto=true, manual=false;
var VISN=['VISIBLE','NIGHT VISION','THERMAL / ICE'];
var CAMN=['Cinematic','Director','Onboard','Rover Chase','Rover POV','Free'];
var phase=PH_ORB, rampU=0, egT=0, landedAt=null, engTemp=260;
var rov=null, rovY=0, found=[false,false,false,false,false], scanHold=0;
var flags={}, free={az:2.5,el:0.30,r:70};
var ringA=A.makeRing(760), ringB=A.makeRing(760), lastSample=-1, LOGN=0;
var camEyeS=null, camTgtS=null;
var manualCmd={f:0,b:0,l:0,r:0};
var blast={x:0,z:0,r:0,s:0};
var settle={t:1e9,amp:0};
var doiU=0, coastU=0;
var ANCHOR=[0,0];
var EVman=0, evCPU=0;

/* ---------- world -> render frame (exact sphere mapping, mirrors the GLSL) ---------- */
function setAnchor(wx,wz){ ANCHOR[0]=Math.round(wx/16)*16; ANCHOR[1]=Math.round(wz/16)*16; }
function toRender(wx,y,wz){
  var lx=wx-ANCHOR[0], lz=wz-ANCHOR[1];
  var s=Math.hypot(lx,lz);
  if(s<1e-4) return [ANCHOR[0], y, ANCHOR[1]];
  var a=s/R_MOON, ca=Math.cos(a), sa=Math.sin(a), rr=R_MOON+y;
  return [ lx/s*rr*sa+ANCHOR[0], rr*ca-R_MOON, lz/s*rr*sa+ANCHOR[1] ];
}
function groundY(x,z){ return TER?TER.heightAt(x,z):0; }

/* ---------- logging / lamps ---------- */
function log(msg){ var el=$('log'); LOGN++;
  var d=document.createElement('div');
  d.innerHTML='<span class="t">'+A.fmtMET(GMET).slice(3)+'</span> '+msg;
  el.appendChild(d); el.scrollTop=el.scrollHeight;
  if(LOGN>150 && el.firstChild) el.removeChild(el.firstChild); }
function setLamp(id,on,blue){ var e=$(id); if(!e) return;
  e.classList.toggle('on',!!on); e.classList.toggle('blue',!!(blue&&on)); }
function hint(t){ $('hint').textContent=t||''; }

/* ---------- ship / rover pose ---------- */
function shipWorld(){
  if(phase<PH_DESC) return [0, 60000, 0];
  if(!S) return [0,0,0];
  var y=S.h;
  if(S.landed && settle.t<6){
    y += -settle.amp*Math.exp(-settle.t/0.32)*Math.cos(settle.t*11.5);
  }
  return [S.x, y, 0];
}
function shipRender(){ var w=shipWorld(); return toRender(w[0],w[1],w[2]); }
function shipLit(){ var w=shipWorld();
  if(!TER) return 1;
  if(w[1]>200) return 1;               /* above the local horizon mask */
  return clamp(TER.sunVisAt(w[0],w[2])+0.05,0,1); }
function roverPoseM(){
  var yaw=A.quatAxisAngle(0,1,0,-rov.hdg);
  var ch=Math.cos(rov.hdg), sh=Math.sin(rov.hdg);
  var hF=groundY(rov.x+ch*1.4,rov.z+sh*1.4), hB=groundY(rov.x-ch*1.4,rov.z-sh*1.4);
  var hL=groundY(rov.x-sh*0.9,rov.z+ch*0.9), hR=groundY(rov.x+sh*0.9,rov.z-ch*0.9);
  var pit=(phase===PH_EG)?(((rov.x-shipWorld()[0])>3.9)?A.rampAngle(1):0):Math.atan((hB-hF)/2.8);
  var rol=(phase===PH_EG)?0:Math.atan((hL-hR)/1.8);
  var p=toRender(rov.x,rovY,rov.z);
  return { q:A.quatMul(yaw,A.quatMul(A.quatAxisAngle(0,0,1,pit),A.quatAxisAngle(1,0,0,rol))), t:p };
}

/* ======================================================================================
   MISSION STEP
   ====================================================================================== */
function resetMission(){
  GMET=0; MET=0; phase=PH_ORB; rampU=0; egT=0; landedAt=null; S=null; rov=null;
  vision=0; lampOn=0; lampAuto=true; manual=false; engTemp=260; scanHold=0;
  doiU=0; coastU=0; warp=1; autoWarp=true;
  found=[false,false,false,false,false]; flags={};
  blast={x:0,z:0,r:0,s:0}; settle={t:1e9,amp:0};
  ringA=A.makeRing(760); ringB=A.makeRing(760); lastSample=-1; camEyeS=null; camMode=0;
  if(DUST){ for(var i=0;i<DUST.n;i++) DUST.L[i]=0; }
  setAnchor(0,0);
  $('log').innerHTML=''; LOGN=0;
  ['lampEng','lampTerm','lampCtc','lampScan'].forEach(function(k){ setLamp(k,false); });
  $('end').classList.add('hide'); $('banner').classList.add('hide'); $('fade').style.opacity=0;
  $('tVis').textContent=VISN[0]; $('tCam').textContent=CAMN[0];
  log('<b>Lunar orbit, 100 km circular.</b> '+A.orbVel(100).toFixed(0)+' m/s. Cargo flight D33-CL2 '+
      'inbound to Forward Base COLDWATER — south-polar ridge, mean illumination '+
      (ASSET.pad.ill*100).toFixed(0)+'%.');
  log('Landing site from LOLA <i>ldem_875s_5m</i>: elev '+ASSET.pad.elev.toFixed(0)+' m, local slope '+
      ASSET.pad.slope.toFixed(1)+'&deg;. Survey target: permanently shadowed region '+
      ASSET.psr.areaKm2.toFixed(1)+' km&sup2; at '+ASSET.psr.T.toFixed(0)+' K.');
  log('<b>Descent plan.</b> DOI '+A.ORB.dvDOI.toFixed(1)+' m/s to a '+(A.ORB.hPeri/1000).toFixed(1)+
      ' km periapsis, coast '+(A.ORB.tCoast/60).toFixed(0)+' min, PDI at '+A.ORB.vPeri.toFixed(0)+
      ' m/s. Braking '+A.PLAN.brake.tgo.toFixed(0)+' s over '+(A.PLAN.brake.D/1000).toFixed(0)+
      ' km, then a '+A.PLAN.approach.tgo.toFixed(0)+' s approach from the high gate. Total &Delta;V '+
      A.PLAN.dvTotal.toFixed(0)+' of '+A.PLAN.dvCap.toFixed(0)+' m/s available.');
  if(MC){
    log('<b>Dispersion analysis</b> ('+MC.n+' cases, two-stage): 3&sigma; ellipse &plusmn;'+
      (3*MC.x.sd).toFixed(0)+' m downrange &times; &plusmn;'+(3*MC.z.sd).toFixed(0)+
      ' m crossrange · touchdown '+Math.abs(MC.vh.mean).toFixed(2)+'&plusmn;'+MC.vh.sd.toFixed(2)+' m/s.');
    log('<b>Site screening</b> on LOLA terrain at each dispersed touchdown: '+
      (MC.safeFrac*100).toFixed(1)+'% meet all abort criteria'+(MC.dom?('; dominant driver <b>'+
      MC.dom+'</b>'):'')+'. Without the base beacon (map-relative nav only) the ellipse opens to &plusmn;'+
      (MC_TRN?(3*MC_TRN.x.sd).toFixed(0):'—')+' m and acceptance falls to '+
      (MC_TRN?(MC_TRN.safeFrac*100).toFixed(0):'—')+'%.');
  }
  hint('Lunar orbit. C camera · V vision · 1/2/3/4 warp.');
}

function beginDescent(){
  S=A.initialState(SEED);
  MET=0; camEyeS=null;
  log('<b>PDI — powered descent initiation.</b> '+(S.h/1000).toFixed(1)+' km AGL · '+
      S.vx.toFixed(0)+' m/s · '+(-S.x/1000).toFixed(0)+' km downrange to the pad.');
  hint('Braking phase — 12.8 min, auto-warped. Autopilot flies the NAVIGATED state.');
  if(autoWarp) setWarp(24,true);
}

function physDescent(dt){
  if(S.landed) return;
  var wasMode=S.mode;
  A.dynStep(S,dt,function(x){ return groundY(x,0); });
  MET=S.t;
  engTemp=Math.min(1180, engTemp + (S.thr>0.02 ? S.thr*260*dt : -dt*3.2));
  if(!flags.ign&&S.thr>0.02){ flags.ign=true; setLamp('lampEng',true);
    log('<b>Descent engines ignition</b> — 3 chambers, '+(S.thr*100).toFixed(0)+'%.'); }
  if(wasMode==='brake'&&S.mode==='approach'){
    log('<b>High gate.</b> '+S.h.toFixed(0)+' m AGL · '+S.vx.toFixed(0)+' m/s · '+
        Math.abs(S.x).toFixed(0)+' m downrange. Pitching up for the approach.');
    hint('Approach phase — the pad is in the window.');
    if(autoWarp) setWarp(1,true);
  }
  if(wasMode==='approach'&&S.mode==='terminal'){ setLamp('lampTerm',true);
    log('<b>Low gate — terminal descent.</b> Nulling drift over the pad.'); }
  if(!flags.ctc&&S.h<=groundY(S.x,0)+1.7){ flags.ctc=true; setLamp('lampCtc',true,true);
    log('<b>CONTACT LIGHT.</b>'); }
  /* plume-scoured zone grows through the last tens of metres and freezes at contact */
  var agl=S.h-groundY(S.x,0);
  if(agl<A.DUST.hOnset&&S.thr>0.05){
    blast.x=S.x; blast.z=0;
    blast.r=Math.max(blast.r, 6+22*(1-agl/A.DUST.hOnset));
    blast.s=Math.max(blast.s, clamp((1-agl/A.DUST.hOnset)*1.15,0,1));
  }
  if(S.landed){
    landedAt={vh:S.tdVh,vx:S.tdVx,t:S.t,fuel:S.m-A.VEH.dry,dv:S.dv,x:S.x,
              tilt:Math.abs(S.pitch*DEG)};
    settle={t:0, amp:Math.min(Math.abs(S.tdVh)*0.09,0.34)};
    setLamp('lampEng',false);
    var hard=Math.abs(landedAt.vh)>A.VEH.gearVh||Math.abs(landedAt.vx)>A.VEH.gearVx;
    log('<b>TOUCHDOWN.</b> '+Math.abs(landedAt.vh).toFixed(2)+' m/s vertical · '+
      Math.abs(landedAt.vx).toFixed(2)+' m/s lateral · tilt '+landedAt.tilt.toFixed(1)+'&deg; · '+
      (hard?'<span style="color:#ff6b6b">HARD</span>':'<span style="color:#39d98a">nominal</span>')+
      '. Pad miss '+Math.abs(landedAt.x).toFixed(1)+' m.');
    showEnd(hard); phase=PH_RAMP; flags.rampT=GMET+2.6;
    hint('Down safe. Cargo bay opening…');
  }
  if(Math.floor(MET*2)!==lastSample){ lastSample=Math.floor(MET*2);
    ringA.push({t:MET,a:S.h-groundY(S.x,0)}); ringB.push({t:MET,vh:S.vh}); }
}

function showEnd(hard){
  $('endTitle').textContent=hard?'Hard contact':'Cargo flight down safe';
  $('eVs').textContent=Math.abs(landedAt.vh).toFixed(2)+' m/s  (lim '+A.VEH.gearVh.toFixed(1)+')';
  $('eHs').textContent=Math.abs(landedAt.vx).toFixed(2)+' m/s  (lim '+A.VEH.gearVx.toFixed(1)+')';
  var gx=groundY(S.x,0), s1=(groundY(S.x+4,0)-gx)/4, s2=(groundY(S.x,4)-gx)/4;
  $('eTilt').textContent=(Math.atan(Math.hypot(s1,s2))*DEG).toFixed(1)+'° terrain · '+
    landedAt.tilt.toFixed(1)+'° vehicle';
  $('eFuel').textContent=(landedAt.fuel/1000).toFixed(2)+' t ('+
    ((landedAt.fuel/(A.VEH.m0-A.VEH.dry))*100).toFixed(0)+'%)';
  $('eDv').textContent=landedAt.dv.toFixed(0)+' m/s';
  $('eT').textContent=(landedAt.t/60).toFixed(1)+' min';
  $('eMiss').textContent=Math.abs(landedAt.x).toFixed(1)+' m'+(MC?('  (3σ '+(3*MC.x.sd).toFixed(0)+' m)'):'');
  var v=$('eVerdict');
  if(hard){ v.textContent='ASSESSMENT: HARD — outside the assumed gear envelope.'; v.style.color='#ff6b6b'; }
  else { v.textContent='ASSESSMENT: NOMINAL — soft, upright, fuel-positive. Surface ops GO.'; v.style.color='#39d98a'; }
  setTimeout(function(){ if(phase>=PH_RAMP&&phase<=PH_EG) $('end').classList.remove('hide'); },1800);
  /* and it must not sit over the drive once the rover is rolling */
}

function egressY(lx){
  if(lx<3.9) return 3.16;
  var th=A.rampAngle(1), reach=3.9+A.RAMP.len*Math.cos(th);
  if(lx<reach) return 3.15-Math.tan(th)*(lx-3.9);
  return 0;
}
function physRover(dt){
  if(phase===PH_EG){
    egT+=dt; rov.v=0.85; rov.hdg=0;
    rov.x=shipWorld()[0]+1.2+rov.v*egT;
    var lx=rov.x-shipWorld()[0];
    rov.spin+=rov.v/A.ROVER.wheelR*dt;
    rovY=groundY(rov.x,rov.z)+egressY(lx);
    if(lx>3.9+A.RAMP.len*Math.cos(A.rampAngle(1))+1.4){
      phase=PH_EXP; rov.wp=0; rov.hold=0;
      log('<b>Rover on the surface.</b> Route: '+ASSET.routeStats.km.toFixed(2)+' km to the PSR, '+
        ASSET.routeStats.drop.toFixed(0)+' m descent, max grade '+ASSET.routeStats.maxGrade.toFixed(1)+
        '&deg; — planned on the LOLA DEM with an 18&deg; limit.');
      hint('Rover deployed — auto-driving the DEM-planned route into permanent shadow.');
    }
    return;
  }
  var cmd;
  if(manual) cmd={thr:(manualCmd.f?1:0)-(manualCmd.b?0.7:0), steer:(manualCmd.r?1:0)-(manualCmd.l?1:0)};
  else {
    cmd=A.autoDrive(rov,dt,ROUTE);
    if(cmd.reached&&cmd.reached.note) log('WP: '+cmd.reached.note);
    if(cmd.reached&&cmd.reached.park&&phase!==PH_DONE){ phase=PH_DONE;
      $('banner').classList.remove('hide');
      log('<b>SURVEY COMPLETE.</b> '+found.filter(Boolean).length+'/'+ICE.length+
        ' cold-trap stations logged · odometer '+(rov.odo/1000).toFixed(2)+' km.');
      hint('Survey complete. M manual drive · V thermal · C cameras · R restart.'); }
  }
  A.roverStep(rov,dt,cmd,TER);
  rovY=groundY(rov.x,rov.z);
  if(lampAuto){ var il=TER.sunVisAt(rov.x,rov.z), want=(il<0.4)?1:0;
    if(want!==lampOn){ lampOn=want; log(want?'<b>Headlights ON</b> — entering shadow.':'Headlights off — sunlit.'); } }
  if(!flags.dk&&TER.illumAt(rov.x,rov.z)<0.02){ flags.dk=true;
    log('<b>Inside permanent shadow.</b> No direct sun at this point in any month — surface '+
      TER.tempAt(rov.x,rov.z).toFixed(0)+' K. Press V for thermal.');
    hint('Permanent shadow. V = thermal — cold traps below 110 K are ice-stable.'); }
  var sc=A.scanTargets(rov.x,rov.z,ICE);
  setLamp('lampScan',sc.total>0.25,true);
  if(sc.best&&sc.best.sig>0.5){ scanHold+=dt;
    if(scanHold>2.0&&!found[sc.best.idx]){ found[sc.best.idx]=true;
      var d=sc.best.dep;
      log('<b>COLD TRAP LOGGED — '+d.id+'</b> · '+d.T.toFixed(0)+' K · illumination '+
        d.ill.toFixed(3)+' · elev '+d.elev.toFixed(0)+' m <i>(ice-stable by temperature; '+
        'candidate only — no neutron/radar measurement)</i>'); }
  } else scanHold=Math.max(0,scanHold-dt*0.5);
  if(Math.floor(GMET*2)!==lastSample){ lastSample=Math.floor(GMET*2);
    ringA.push({t:GMET,a:TER.tempAt(rov.x,rov.z)}); ringB.push({t:GMET,vh:rov.v}); }
}

function stepMission(dt){
  GMET+=dt;
  if(settle.t<1e8) settle.t+=dt;
  if(phase===PH_ORB){
    if(GMET>=T_ORB){ phase=PH_DOI;
      log('<b>Deorbit insertion burn.</b> Retrograde, '+A.ORB.dvDOI.toFixed(1)+
          ' m/s to lower periapsis to '+(A.ORB.hPeri/1000).toFixed(1)+' km.');
      hint('DOI burn — then a half-orbit coast to PDI.'); }
  } else if(phase===PH_DOI){
    doiU+=dt/T_DOI;
    if(doiU>=1){ phase=PH_COAST; coastU=0;
      log('<b>DOI complete.</b> Coasting '+(A.ORB.tCoast/60).toFixed(0)+
          ' min to periapsis. <i>(compressed)</i>');
      hint('Coast to periapsis — compressed.'); }
  } else if(phase===PH_COAST){
    coastU+=dt/T_COASTVIEW;
    GMET+=A.ORB.tCoast*(dt/T_COASTVIEW);            /* MET advances by the real coast */
    $('fade').style.opacity=(coastU>0.72)?smoo((coastU-0.72)/0.28):0;
    if(coastU>=1){ phase=PH_DESC; beginDescent(); camEyeS=null; }
  } else if(phase===PH_DESC){
    $('fade').style.opacity=Math.max(0,$('fade').style.opacity-dt*1.6);
    physDescent(dt);
  } else {
    engTemp=Math.max(115,engTemp-dt*3.2);
    if(phase===PH_RAMP){
      if(GMET>=flags.rampT){
        if(!flags.ramp){ flags.ramp=true; $('end').classList.add('hide'); log('<b>Cargo bay opening.</b>'); }
        rampU=Math.min(1,rampU+dt/A.RAMP.dur);
        if(rampU>=1&&!flags.eg){ flags.eg=true;
          rov=A.roverInit(shipWorld()[0]+1.2,0,0); rovY=groundY(rov.x,0)+3.16; egT=0; phase=PH_EG;
          log('<b>Ramp down.</b> Rover power-up, lamp test, rolling out.'); }
      }
    } else if(rov){ if(phase>=PH_EXP) $('end').classList.add('hide'); physRover(dt); }
  }
}

/* ======================================================================================
   DUST — vacuum ejecta sheet
   FACT: with no atmosphere the plume scours regolith that departs at a few degrees above
   horizontal at tens of m/s and flies a pure ballistic arc to the horizon. It does not
   billow, hang, or settle slowly, which is why Apollo landing films look nothing like a
   helicopter downwash.
   ====================================================================================== */
var dustRng=A.makeRng(0xd51e);
function dustSpawn(dt){
  if(!DUST||phase!==PH_DESC||!S||S.landed) return;
  var gy=groundY(S.x,0), agl=S.h-gy;
  if(agl>A.DUST.hOnset||S.thr<0.05||agl<0) return;
  var prox=1-agl/A.DUST.hOnset;
  var rate=A.DUST.rate*S.thr*prox*prox;
  var n=Math.min(Math.floor(rate*dt)+((dustRng()<(rate*dt)%1)?1:0),90);
  for(var i=0;i<n;i++){
    var idx=DUST.head; DUST.head=(DUST.head+1)%DUST.n;
    var a=dustRng()*Math.PI*2, r0=1.5+dustRng()*5.5;
    var el=A.DUST.angMin+(A.DUST.angMax-A.DUST.angMin)*dustRng()*dustRng();
    var sp=(A.DUST.vMin+(A.DUST.vMax-A.DUST.vMin)*dustRng())*(0.45+0.55*S.thr)*(0.5+0.5*prox);
    var ca=Math.cos(a), sa=Math.sin(a), ce=Math.cos(el), se=Math.sin(el);
    DUST.P[idx*3]=S.x+ca*r0; DUST.P[idx*3+1]=gy+0.25+dustRng()*0.5; DUST.P[idx*3+2]=sa*r0;
    DUST.V[idx*3]=ca*sp*ce;  DUST.V[idx*3+1]=sp*se;                 DUST.V[idx*3+2]=sa*sp*ce;
    DUST.L[idx]=A.DUST.life[0]+(A.DUST.life[1]-A.DUST.life[0])*dustRng();
    DUST.S[idx]=0.5+dustRng()*1.3;
  }
  DUST.sizeDirty=true;
}
function dustStep(dt){
  if(!DUST) return;
  var g=A.G_MOON, any=false;
  for(var i=0;i<DUST.n;i++){
    if(DUST.L[i]<=0) continue;
    any=true;
    DUST.L[i]-=dt*0.16;                       /* long-lived: they fly, they do not settle */
    DUST.V[i*3+1]-=g*dt;
    DUST.P[i*3]+=DUST.V[i*3]*dt;
    DUST.P[i*3+1]+=DUST.V[i*3+1]*dt;
    DUST.P[i*3+2]+=DUST.V[i*3+2]*dt;
    if(DUST.P[i*3+1]<groundY(DUST.P[i*3],DUST.P[i*3+2])) DUST.L[i]=0;
  }
  DUST.live=any;
}
function dustUpload(){
  if(!DUST||!DUST.live) return;
  gl.bindBuffer(gl.ARRAY_BUFFER,DUST.pb); gl.bufferSubData(gl.ARRAY_BUFFER,0,DUST.P);
  gl.bindBuffer(gl.ARRAY_BUFFER,DUST.lb); gl.bufferSubData(gl.ARRAY_BUFFER,0,DUST.L);
  if(DUST.sizeDirty){ gl.bindBuffer(gl.ARRAY_BUFFER,DUST.sb);
    gl.bufferSubData(gl.ARRAY_BUFFER,0,DUST.S); DUST.sizeDirty=false; }
}

/* ======================================================================================
   CAMERAS
   ====================================================================================== */
function orbitCam(){
  /* Wide external shot: the vehicle small against the limb, sun raking from the side. */
  var alt=(phase===PH_ORB||phase===PH_DOI)?100000:(100000-(100000-A.ORB.hPeri)*smoo(coastU));
  var d=48+30*smoo(GMET/T_ORB);
  var az=0.9+GMET*0.02;
  var eye=[Math.cos(az)*d, alt+16+8*Math.sin(GMET*0.3), Math.sin(az)*d];
  return {eye:eye, tgt:[0,alt,0], alt:alt};
}
function cameraView(rdt){
  var eye,tgt,up=[0,1,0];
  if(phase<PH_DESC){
    var oc=orbitCam();
    setAnchor(0,0);
    eye=oc.eye; tgt=oc.tgt;
  } else {
    var W=shipWorld(), L=shipRender();
    var Rw=rov?[rov.x,rovY,rov.z]:W;
    var Rr=rov?toRender(rov.x,rovY,rov.z):L;
    /* the terrain grid is anchored under whatever the camera is following */
    if(rov&&phase>=PH_EG) setAnchor(rov.x,rov.z); else setAnchor(W[0],W[2]);
    L=shipRender(); Rr=rov?toRender(rov.x,rovY,rov.z):L;
    var m=camMode;
    if(phase===PH_DESC&&m>=3) m=1;
    var agl=S?(S.h-groundY(S.x,0)):0;
    if(m===0){
      if(phase===PH_DESC){
        if(S.mode==='brake'){
          /* chase: behind and above, looking along the velocity vector at the surface */
          var back=Math.min(120+agl*0.02,340);
          eye=[L[0]-back, L[1]+back*0.30, back*0.55];
          tgt=[L[0]+260, L[1]-agl*0.28, 0];
        } else {
          var ah=clamp(agl*0.45,16,300);
          eye=[L[0]+ah*0.5, L[1]+ah*0.16+6, 34+agl*0.18];
          tgt=[L[0],L[1]+2,0];
        }
      } else {
        var C=(rov&&phase>=PH_EXP)?Rr:L, an=GMET*0.055;
        eye=[C[0]+Math.cos(an)*26,C[1]+9,C[2]+Math.sin(an)*26]; tgt=[C[0],C[1]+1.8,C[2]];
      }
    } else if(m===1){
      var C2=(rov&&phase>=PH_EXP)?Rr:L;
      var cw=(rov&&phase>=PH_EXP)?Rw:W;
      var gy=groundY(cw[0]+34,cw[2]+26);
      var gp=toRender(cw[0]+34,gy+3.5,cw[2]+26);
      eye=gp; tgt=[C2[0],C2[1]+2.5,C2[2]];
    } else if(m===2){
      /* Onboard: a downward-looking camera under the deck, framing the ground track ahead —
         the Apollo 16 mm sequence-camera view. Offset to the side so the hull does not fill
         the frame, and aimed at the surface, not at a point in space. */
      var vd=(S&&S.vx<-0.5)?-1:1;
      eye=[L[0]-vd*1.2, L[1]-3.4, 2.6];
      /* Aim well down-track — scaled to altitude — so the shot frames the ground streaming
         past and the horizon beyond, rather than staring straight down at a flat patch. */
      var ax2=(S?S.x:0)+vd*clamp(agl*5.5,150,90000);
      tgt=toRender(ax2, groundY(ax2,0)+agl*0.10, 0);
    } else if(m===3){
      var ch=Math.cos(rov.hdg),sh=Math.sin(rov.hdg);
      var cg=toRender(rov.x-ch*9,rovY+5.0,rov.z-sh*9);
      eye=cg; tgt=[Rr[0]+ch*5,Rr[1]+1.2,Rr[2]+sh*5];
    } else if(m===4){
      var pm=roverPoseM(), M=mFromQT(pm.q,pm.t);
      eye=xfp(M,[0.98,1.75,0]); var fw=xfd(M,[1,-0.06,0]);
      tgt=[eye[0]+fw[0]*10,eye[1]+fw[1]*10,eye[2]+fw[2]*10];
    } else {
      var C3=(rov&&phase>=PH_EXP)?Rr:L;
      var ce=[Math.cos(free.az)*Math.cos(free.el),Math.sin(free.el),Math.sin(free.az)*Math.cos(free.el)];
      eye=[C3[0]+ce[0]*free.r,C3[1]+ce[1]*free.r+2,C3[2]+ce[2]*free.r]; tgt=[C3[0],C3[1]+2,C3[2]];
    }
  }
  if(!camEyeS){ camEyeS=eye; camTgtS=tgt; }
  var snap=(phase<PH_DESC)||(S&&S.mode==='brake'&&camMode===0);
  if(snap){ camEyeS=eye; camTgtS=tgt; }
  else { var k=1-Math.exp(-rdt*5.5); camEyeS=lerp3(camEyeS,eye,k); camTgtS=lerp3(camTgtS,tgt,k); }
  return {eye:camEyeS.slice(), tgt:camTgtS.slice(), V:mLookAt(camEyeS,camTgtS,up)};
}

/* shadow map: sun-aligned orthographic box around the action */
function shadowMatrix(focus){
  var L=vScale(SUN,-1);
  var right=vNorm(vCross([0,1,0],L)), upv=vNorm(vCross(L,right));
  var back=vAdd(focus, vScale(SUN, 420));
  var V=mLookAt(back, focus, upv);
  var P=mOrtho(-90,90,-48,48,1,900);
  return mMul(P,V);
}

/* ======================================================================================
   DRAW
   ====================================================================================== */
var DRAWS=0;
var P=GFX.programs, UL=GFX.uniforms;
function bindCommon(u){
  gl.uniform3f(u.Sun,SUN[0],SUN[1],SUN[2]);
  gl.uniform1f(u.SunIrr,SUN_IRR);
  gl.uniform1f(u.SunEl,SUN_EL);
  gl.uniform1f(u.Earthshine,EARTHSHINE);
  gl.uniform1i(u.Vision,vision);
  gl.uniform1f(u.T,GMET);
  gl.uniform1i(u.Post,usePost?1:0);
  gl.uniform1f(u.EV,evCPU);
}
function bindLamps(u){
  var on=0,p0=[0,0,0],d0=[1,0,0],p1=[0,0,0],d1=[1,0,0];
  if(rov&&lampOn&&phase>=PH_EG){
    var pm=roverPoseM(), M=mFromQT(pm.q,pm.t);
    p0=xfp(M,[1.36,1.32,0.52]); p1=xfp(M,[1.36,1.32,-0.52]);
    d0=d1=xfd(M,vNorm([1,-0.16,0])); on=1;
  }
  gl.uniform1f(u.LampOn,on);
  gl.uniform1f(u.LampI,A.ROVER.lampI);
  gl.uniform3f(u.Lp0,p0[0],p0[1],p0[2]); gl.uniform3f(u.Ld0,d0[0],d0[1],d0[2]);
  gl.uniform3f(u.Lp1,p1[0],p1[1],p1[2]); gl.uniform3f(u.Ld1,d1[0],d1[1],d1[2]);
  var fw=(phase>=PH_RAMP&&S)?0.9*Math.min(rampU*1.6,1):0, sp=shipRender();
  gl.uniform4f(u.Flood,sp[0]+4.2,sp[1]+6.4,sp[2],fw);
}
function bindShadow(u){
  var sm=GFX.shadow;
  if(sm&&SHADOWVP&&vision===0){
    gl.uniformMatrix4fv(u.ShadowVP,false,SHADOWVP);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D,sm.tex);
    gl.uniform1i(u.ShadowTex,3);
    gl.uniform1f(u.ShadowOn,1); gl.uniform1f(u.ShadowTexel,sm.texel);
  } else gl.uniform1f(u.ShadowOn,0);
}
var SHADOWVP=null;

function drawParts(list,pose,lit,VP,eye,dyn,depthOnly){
  var pr=depthOnly?P.depth:P.part, u=depthOnly?UL.depth:UL.part;
  gl.useProgram(pr);
  gl.uniformMatrix4fv(u.VP,false,VP);
  gl.uniformMatrix4fv(u.Pose,false,pose);
  if(!depthOnly){
    gl.uniform3f(u.Eye,eye[0],eye[1],eye[2]);
    gl.uniform1f(u.Lit,lit);
    bindCommon(u); bindLamps(u); bindShadow(u);
  }
  for(var i=0;i<list.length;i++){
    var pv=list[i], p=pv.part, M=pv.M, emis=p.emis||0, tk=p.tk||0;
    if(dyn){ var o=dyn(pv); if(o){ if(o.M) M=o.M; if(o.emis!=null) emis=o.emis;
      if(o.tk!=null) tk=o.tk; if(o.skip) continue; } }
    gl.uniformMatrix4fv(u.M,false,M);
    if(!depthOnly){
      if(!tk) tk=(p.eng?engTemp:(lit>0.4?215:95));
      gl.uniform3f(u.Color,p.color[0],p.color[1],p.color[2]);
      gl.uniform1f(u.Metal,p.metal!=null?p.metal:0.4);
      gl.uniform1f(u.Rough,p.rough!=null?p.rough:0.6);
      gl.uniform1f(u.Emis,emis); gl.uniform1f(u.Foil,p.foil?1:0); gl.uniform1f(u.TempK,tk);
    }
    gl.bindVertexArray(pv.v.vao); gl.drawElements(gl.TRIANGLES,pv.v.n,pv.v.type,0); DRAWS++;
  }
}
function shipDyn(pv){ var p=pv.part;
  if(p.ramp){ var th=A.rampAngle(rampU);
    return {M:mMul(mFromQT(A.quatAxisAngle(0,0,1,-th),A.RAMP.hinge),
                   mFromQT([0,0,0,1],[A.RAMP.len/2,-0.11,0]))}; }
  if(p.flood) return {emis:(phase>=PH_RAMP?0.30*Math.min(rampU*1.6,1):0)};
  return null; }
function rovDyn(pv){ var p=pv.part;
  if(p.wheel) return {M:mFromQT(A.quatMul(A.quatAxisAngle(0,0,1,-rov.spin),p.q),p.t)};
  if(p.lampL||p.lampR) return {emis:lampOn?0.28:0.0006, tk:lampOn?330:110};
  return null; }
function baseDyn(pv){
  if(pv.part.beacon) return {emis:(Math.sin(GMET*4.2)>0)?0.22:0.002};
  if(pv.part.padLt) return {emis:0.10+0.05*Math.sin(GMET*2.0+pv.M[12])};
  return null; }

function drawTerrain(VP,eye,range){
  gl.useProgram(P.ter);
  var u=UL.ter;
  gl.uniformMatrix4fv(u.VP,false,VP);
  gl.uniform1f(u.R,R_MOON);
  gl.uniform2f(u.Focus,ANCHOR[0],ANCHOR[1]);
  gl.uniform2f(u.Anchor,ANCHOR[0],ANCHOR[1]);
  gl.uniform3f(u.Eye,eye[0],eye[1],eye[2]);
  gl.uniform1f(u.DetailR,Q.detailR);
  gl.uniform1f(u.Apron0,A.SITE.apronR0); gl.uniform1f(u.Apron1,A.SITE.apronR1);
  gl.uniform2f(u.DemA,DEMA[0],DEMA[1]); gl.uniform2f(u.DemB,DEMB[0],DEMB[1]);
  gl.uniform1f(u.DemN,DEMTEX.N);
  gl.uniform2f(u.DemCtr,TER.centerX,TER.centerZ);
  gl.uniform1f(u.DemHalf,TER.halfW);
  gl.uniform4f(u.Blast,blast.x,blast.z,Math.max(blast.r,1),blast.s);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D,DEMTEX.elev); gl.uniform1i(u.Dem,0);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D,DEMTEX.aux); gl.uniform1i(u.Aux,1);
  gl.uniform1i(u.IceN,ICE.length);
  for(var i=0;i<5;i++){
    if(i<ICE.length){ gl.uniform4f(UL.terIce[i],ICE[i].x,ICE[i].z,ICE[i].r,ICE[i].s);
      gl.uniform1f(UL.terIceG[i],found[i]?1:0); }
    else { gl.uniform4f(UL.terIce[i],0,0,1,0); gl.uniform1f(UL.terIceG[i],0); } }
  bindCommon(u); bindLamps(u); bindShadow(u);
  gl.bindVertexArray(GRID.vao);
  if(range==='near') gl.drawElements(gl.TRIANGLES,GRID.nearCount,gl.UNSIGNED_INT,0);
  else gl.drawElements(gl.TRIANGLES,GRID.farCount,gl.UNSIGNED_INT,GRID.farOffset*4);
  DRAWS++;
}
var DEMA=[0,0], DEMB=[0,0];

function drawSky(VP,eye){
  /* stars first (depth-disabled, at infinity), then the sun disc and Earth */
  gl.depthMask(false);
  gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA,gl.ONE);
  gl.useProgram(P.star);
  gl.uniformMatrix4fv(UL.star.VP,false,VP);
  gl.uniform1f(UL.star.PS,Q.dpr*1.4);
  gl.uniform1i(UL.star.Post,Q.post?1:0); gl.uniform1f(UL.star.EV,evCPU);
  gl.bindVertexArray(STARS.vao); gl.drawArrays(gl.POINTS,0,STARS.n); DRAWS++;

  gl.useProgram(P.disc);
  gl.uniformMatrix4fv(UL.disc.VP,false,VP);
  gl.uniform1i(UL.disc.Post,Q.post?1:0); gl.uniform1f(UL.disc.EV,evCPU);
  var right=vNorm(vCross([0,1,0],SUN)), upv=vNorm(vCross(SUN,right));
  /* Sun: 0.53 deg across as seen from the Moon (FACT). */
  var sd=Math.tan(0.53*0.5*RAD);
  gl.uniform3f(UL.disc.Center,SUN[0],SUN[1],SUN[2]);
  gl.uniform2f(UL.disc.Size,sd,sd);
  gl.uniform3f(UL.disc.Right,right[0],right[1],right[2]);
  gl.uniform3f(UL.disc.Up,upv[0],upv[1],upv[2]);
  gl.uniform1i(UL.disc.Kind,0);
  gl.uniform1f(UL.disc.Intensity,SUN_IRR*7000.0);
  gl.bindVertexArray(DISC.vao); gl.drawArrays(gl.TRIANGLES,0,6); DRAWS++;

  /* Earth: ~1.9 deg across from the Moon (FACT), and from the south pole it sits low and
     nearly fixed — the Moon keeps one face towards it. */
  var ed=Math.tan(1.9*0.5*RAD);
  var EDIR=vNorm([0.42,0.10,-0.90]);
  var er=vNorm(vCross([0,1,0],EDIR)), eu=vNorm(vCross(EDIR,er));
  gl.uniform3f(UL.disc.Center,EDIR[0],EDIR[1],EDIR[2]);
  gl.uniform2f(UL.disc.Size,ed,ed);
  gl.uniform3f(UL.disc.Right,er[0],er[1],er[2]);
  gl.uniform3f(UL.disc.Up,eu[0],eu[1],eu[2]);
  gl.uniform1i(UL.disc.Kind,1);
  gl.uniform3f(UL.disc.Sun,SUN[0],SUN[1],SUN[2]);
  gl.uniform1f(UL.disc.Intensity,0.35);
  gl.drawArrays(gl.TRIANGLES,0,6); DRAWS++;
  gl.disable(gl.BLEND);
  gl.depthMask(true);
}

var eng3=[[0,0],[-1.85,1.55],[-1.85,-1.55]];
function drawPlume(VP,pose,thr){
  gl.enable(gl.BLEND); gl.depthMask(false); gl.blendFunc(gl.SRC_ALPHA,gl.ONE);
  gl.useProgram(P.plume);
  gl.uniformMatrix4fv(UL.plume.VP,false,VP);
  gl.uniformMatrix4fv(UL.plume.Pose,false,pose);
  gl.uniform1f(UL.plume.T,GMET); gl.uniform1f(UL.plume.Thr,thr);
  gl.uniform1i(UL.plume.Post,Q.post?1:0); gl.uniform1f(UL.plume.EV,evCPU);
  for(var b=0;b<3;b++){
    gl.uniformMatrix4fv(UL.plume.M,false,mFromQT([0,0,0,1],[eng3[b][0],-1.45,eng3[b][1]]));
    gl.bindVertexArray(vPlume.vao); gl.drawElements(gl.TRIANGLES,vPlume.n,vPlume.type,0); DRAWS++; }
  gl.depthMask(true); gl.disable(gl.BLEND);
}

/* ---------- HUD canvases ---------- */
function drawChart(id,arr,key,label,color,unit){
  var c=$(id); if(!c) return; var g=c.getContext('2d'),W=c.width,H=c.height;
  g.clearRect(0,0,W,H); g.fillStyle='rgba(10,14,22,0.92)'; g.fillRect(0,0,W,H);
  g.strokeStyle='rgba(120,140,170,0.25)'; g.strokeRect(0.5,0.5,W-1,H-1);
  g.fillStyle='#8fa8c8'; g.font='10px monospace'; g.fillText(label,7,12);
  if(arr.length<2) return;
  var mx=-1e9,mn=1e9,i;
  for(i=0;i<arr.length;i++){ var v=arr[i][key]; if(v>mx)mx=v; if(v<mn)mn=v; }
  if(mx-mn<1e-6){ mx+=1; mn-=1; }
  g.strokeStyle=color; g.beginPath();
  for(i=0;i<arr.length;i++){ var px=6+(W-12)*i/(arr.length-1);
    var py=H-6-(H-18)*((arr[i][key]-mn)/(mx-mn));
    if(i===0) g.moveTo(px,py); else g.lineTo(px,py); }
  g.stroke();
  g.fillStyle='#c8d6ea'; g.fillText(arr[arr.length-1][key].toFixed(1)+' '+unit,W-84,12);
}
function drawDispersion(){
  var c=$('chDisp'); if(!c||!c.getContext||!MC||!TER) return;
  var g=c.getContext('2d'), W=c.width, H=c.height;
  g.clearRect(0,0,W,H);
  var M=(dispMode===0)?MC:MC_TRN;
  if(!M) return;
  var cx=M.x.mean, cz=M.z.mean;
  var half=Math.max(3.4*Math.max(M.x.sd,M.z.sd),70);
  var toPx=function(x,z){ return [ (x-cx)/half*(W/2)+W/2, (z-cz)/half*(W/2)+H/2 ]; };
  var STEP=5;
  for(var py=0;py<H;py+=STEP) for(var px=0;px<W;px+=STEP){
    var wx=(px-W/2)/(W/2)*half+cx, wz=(py-H/2)/(W/2)*half+cz;
    var sl=TER.slopeDem(wx,wz);
    var t=Math.min(sl/(M.crit.slopeDeg*1.6),1);
    var r=Math.round(24+t*186), gg=Math.round(38+(1-t)*90), b=Math.round(52+(1-t)*70);
    if(sl>M.crit.slopeDeg){ r=150+Math.round(t*80); gg=40; b=48; }
    g.fillStyle='rgb('+r+','+gg+','+b+')';
    g.fillRect(px,py,STEP,STEP);
  }
  for(var i=0;i<M.cases.length;i++){
    var k=M.cases[i], p=toPx(k.x,k.z);
    g.fillStyle=k.ok?'rgba(90,230,150,0.95)':'rgba(255,120,110,0.95)';
    g.fillRect(p[0]-1.5,p[1]-1.5,3,3);
  }
  g.strokeStyle='rgba(215,168,60,0.95)'; g.lineWidth=1.4;
  [1,3].forEach(function(k){
    g.beginPath();
    g.ellipse(W/2,H/2, M.x.sd*k/half*(W/2), M.z.sd*k/half*(W/2), 0,0,Math.PI*2);
    g.setLineDash(k===1?[]:[4,3]); g.stroke();
  });
  g.setLineDash([]);
  var pp=toPx(0,0);
  g.strokeStyle='#5ad2ff'; g.lineWidth=1.4;
  g.beginPath(); g.moveTo(pp[0]-7,pp[1]); g.lineTo(pp[0]+7,pp[1]);
  g.moveTo(pp[0],pp[1]-7); g.lineTo(pp[0],pp[1]+7); g.stroke();
  g.fillStyle='#c9d6ea'; g.font='9px monospace';
  g.fillText((dispMode===0?'BEACON-AIDED':'MAP-RELATIVE ONLY')+'  ·  scale '+(half*2).toFixed(0)+' m', 6, 12);
  g.fillText('slope > '+M.crit.slopeDeg+'° = abort  ·  50 m/px DEM', 6, H-6);
}
var dispMode=0;
function drawCharts(){
  if(phase<=PH_RAMP){ drawChart('chAlt',ringA.get(),'a','ALTITUDE AGL','#5ad2ff','m');
    drawChart('chVel',ringB.get(),'vh','VERTICAL SPEED','#ffcf5c','m/s'); }
  else if(rov){ drawChart('chAlt',ringA.get(),'a','SURFACE TEMP @ ROVER','#ff9a5c','K');
    drawChart('chVel',ringB.get(),'vh','ROVER SPEED','#5aff9a','m/s'); }
}

/* ---------- input ---------- */
var dragging=false,lmx=0,lmy=0,uiHidden=false;
function cycleCam(){ camMode=(camMode+1)%CAMN.length; $('tCam').textContent=CAMN[camMode]; camEyeS=null; }
function cycleVis(){ vision=(vision+1)%3; $('tVis').textContent=VISN[vision]; }
function setWarp(w,auto){ warp=w; if(!auto) autoWarp=false;
  $('tWarp').textContent=w+'×'+(autoWarp?' auto':''); }
window.addEventListener('keydown',function(e){
  var k=e.key.toLowerCase();
  if(k==='c') cycleCam();
  if(k==='v') cycleVis();
  if(k==='l'){ lampAuto=false; lampOn=lampOn?0:1; log('Headlights '+(lampOn?'ON':'off')+' (manual).'); }
  if(k==='m'&&rov&&phase>=PH_EXP){ manual=!manual; $('rMode').textContent=manual?'MANUAL':'AUTO';
    log(manual?'<b>Manual rover control.</b> W/S drive · A/D steer.':'Auto route resumed.'); }
  if(k==='w'||k==='arrowup') manualCmd.f=1;
  if(k==='s'||k==='arrowdown') manualCmd.b=1;
  if(k==='a'||k==='arrowleft') manualCmd.l=1;
  if(k==='d'||k==='arrowright') manualCmd.r=1;
  if(k==='1') setWarp(1); if(k==='2') setWarp(4); if(k==='3') setWarp(16); if(k==='4') setWarp(64);
  if(k==='e'){ EVman=clamp(EVman+0.5,-4,4); log('Exposure bias '+(EVman>=0?'+':'')+EVman.toFixed(1)+' EV'); }
  if(k==='q'){ EVman=clamp(EVman-0.5,-4,4); log('Exposure bias '+(EVman>=0?'+':'')+EVman.toFixed(1)+' EV'); }
  if(k==='n'){ dispMode=1-dispMode; drawDispersion(); }
  if(k==='p') paused=!paused;
  if(k==='r'){ resetMission(); paused=false; }
  if(k==='h'){ uiHidden=!uiHidden;
    ['tele','right','keys','log'].forEach(function(id){ $(id).classList.toggle('hide',uiHidden); }); }
});
window.addEventListener('keyup',function(e){ var k=e.key.toLowerCase();
  if(k==='w'||k==='arrowup') manualCmd.f=0;
  if(k==='s'||k==='arrowdown') manualCmd.b=0;
  if(k==='a'||k==='arrowleft') manualCmd.l=0;
  if(k==='d'||k==='arrowright') manualCmd.r=0; });
cv.addEventListener('mousedown',function(e){ dragging=true; lmx=e.clientX; lmy=e.clientY;
  if(camMode!==5){ camMode=5; $('tCam').textContent=CAMN[5]; camEyeS=null; } });
window.addEventListener('mouseup',function(){ dragging=false; });
window.addEventListener('mousemove',function(e){ if(!dragging) return;
  free.az+=(e.clientX-lmx)*0.006; free.el=clamp(free.el+(e.clientY-lmy)*0.005,-0.1,1.35);
  lmx=e.clientX; lmy=e.clientY; });
cv.addEventListener('wheel',function(e){ free.r=clamp(free.r*(1+e.deltaY*0.001),6,1400); e.preventDefault(); },{passive:false});
var tPrev=null,tDist=0;
cv.addEventListener('touchstart',function(e){
  if(e.touches.length===1){ tPrev={x:e.touches[0].clientX,y:e.touches[0].clientY};
    if(camMode!==5){ camMode=5; $('tCam').textContent=CAMN[5]; camEyeS=null; } }
  else if(e.touches.length===2){ tDist=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,
    e.touches[0].clientY-e.touches[1].clientY); }
},{passive:true});
cv.addEventListener('touchmove',function(e){
  if(e.touches.length===1&&tPrev){ free.az+=(e.touches[0].clientX-tPrev.x)*0.007;
    free.el=clamp(free.el+(e.touches[0].clientY-tPrev.y)*0.006,-0.1,1.35);
    tPrev={x:e.touches[0].clientX,y:e.touches[0].clientY}; }
  else if(e.touches.length===2){ var d=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,
    e.touches[0].clientY-e.touches[1].clientY);
    if(tDist>0) free.r=clamp(free.r*(tDist/Math.max(d,1)),6,1400); tDist=d; }
  e.preventDefault();
},{passive:false});
cv.addEventListener('touchend',function(){ tPrev=null; tDist=0; },{passive:true});
['btnCam','btnVis','btnWarp','btnPause'].forEach(function(id){
  var b=$(id); if(!b) return;
  b.addEventListener('click',function(){
    if(id==='btnCam') cycleCam();
    if(id==='btnVis') cycleVis();
    if(id==='btnWarp') setWarp(warp===1?4:(warp===4?16:(warp===16?64:1)));
    if(id==='btnPause'){ paused=!paused; b.textContent=paused?'▶':'❚❚'; }
  });
});
function resize(){
  var dpr=Math.min(window.devicePixelRatio||1,Q.dpr);
  cv.width=Math.max(2,Math.floor(cv.clientWidth*dpr));
  cv.height=Math.max(2,Math.floor(cv.clientHeight*dpr));
  GFX.resizeTargets(cv.width,cv.height);
}
window.addEventListener('resize',resize);
cv.addEventListener('webglcontextlost',function(ev){ ev.preventDefault(); ctxLost=true;
  window.showFatal('WebGL context lost — reloading resources…');
  setTimeout(function(){ window.location.reload(); },800); });

/* ======================================================================================
   FRAME
   ====================================================================================== */
var lastRT=0, acc=0, FIXED=1/60, fpsA=0, fpsN=0, chartT=0, frameMs=0, MAXSUB=8, hidden=false;
/* The HDR target + AgX chain exists to tonemap SCENE-LINEAR radiance. Night vision and
   thermal are already final display colours, so they are drawn straight to the backbuffer
   and skip the post chain altogether — cheaper, and it keeps false colour exactly as the
   palette defines it. */
var usePost=true;
document.addEventListener('visibilitychange',function(){ hidden=document.hidden; });

function cpuExposure(dt){
  /* Used verbatim on the LOW tier (no float target) and as the post-pass bias elsewhere.
     Estimates the scene key from what the camera is actually looking at. */
  var key;
  if(phase<PH_DESC) key=0.02;
  else {
    var fx=rov&&phase>=PH_EXP?rov.x:(S?S.x:0), fz=rov&&phase>=PH_EXP?rov.z:0;
    var vis=TER?TER.sunVisAt(fx,fz):1;
    key=0.13*SUN_IRR*(vis*Math.sin(Math.max(SUN_EL,0))*2.2+0.004)+ (lampOn?0.010:0);
  }
  var target=-Math.log2(Math.max(key,1e-5))-1.6;
  if(!evCPU) evCPU=target;
  evCPU += (target-evCPU)*(1-Math.exp(-dt*1.4));
  return evCPU+EVman;
}

function frame(now){
  requestAnimationFrame(frame);
  if(ctxLost) return;
  if(!lastRT) lastRT=now;
  var rdt=Math.min((now-lastRT)/1000,0.25); lastRT=now;
  if(hidden) return;
  var t0=performance.now();
  fpsA+=rdt; fpsN++;
  if(fpsA>0.5){ var fps=fpsN/fpsA; $('tFps').textContent=fps.toFixed(0)+' fps';
    $('tMs').textContent=frameMs.toFixed(1)+' ms'; fpsA=0; fpsN=0; }

  if(!paused&&started&&TER){
    acc+=rdt*warp;
    var sub=0, lim=MAXSUB*Math.max(1,warp);
    while(acc>=FIXED&&sub<lim){ stepMission(FIXED); dustSpawn(FIXED); dustStep(FIXED); acc-=FIXED; sub++; }
    if(acc>FIXED*40) acc=0;
  }
  var cam=cameraView(rdt), asp=cv.width/Math.max(cv.height,1);
  evCPU=cpuExposure(rdt);
  usePost = Q.post && vision===0;
  DRAWS=0;

  /* ---- shadow pass (objects only; terrain self-shadowing comes from the DEM raster) ---- */
  var sm=GFX.shadow;
  SHADOWVP=null;
  if(sm&&phase>=PH_DESC&&vision===0){
    var focusW=(rov&&phase>=PH_EG)?[rov.x,rov.z]:[S?S.x:0,0];
    var fr=toRender(focusW[0],groundY(focusW[0],focusW[1]),focusW[1]);
    SHADOWVP=shadowMatrix(fr);
    gl.bindFramebuffer(gl.FRAMEBUFFER,sm.fbo);
    gl.viewport(0,0,sm.size,sm.size);
    gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.disable(gl.BLEND);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.CULL_FACE); gl.cullFace(gl.FRONT);
    var spS=shipRender();
    var shipPoseS=mFromQT(A.quatAxisAngle(0,0,1,-(S?S.pitch:0)),spS);
    drawParts(shipV,shipPoseS,1,SHADOWVP,cam.eye,shipDyn,true);
    drawParts(baseV,mFromQT([0,0,0,1],toRender(0,0,0)),1,SHADOWVP,cam.eye,baseDyn,true);
    if(rov&&phase>=PH_EG){ var pmS=roverPoseM();
      drawParts(rovV,mFromQT(pmS.q,pmS.t),1,SHADOWVP,cam.eye,rovDyn,true); }
    gl.disable(gl.CULL_FACE);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
  }

  /* ---- scene ---- */
  var target=usePost?GFX.RT.fbo:null;
  gl.bindFramebuffer(gl.FRAMEBUFFER,target);
  gl.viewport(0,0,cv.width,cv.height);
  gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
  gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE); gl.depthMask(true);
  gl.clearColor(0,0,0,1); gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);

  /* FAR pass: horizon and the curved limb, with its own frustum */
  var VPfar=mMul(mPersp(48*RAD,asp,12000,4.6e6),cam.V);
  drawSky(VPfar,cam.eye);
  drawTerrain(VPfar,cam.eye,'far');
  gl.clear(gl.DEPTH_BUFFER_BIT);

  /* NEAR pass */
  var VP=mMul(mPersp(48*RAD,asp,0.22,26000),cam.V);
  drawTerrain(VP,cam.eye,'near');

  if(phase>=PH_DESC){
    var sp2=shipRender();
    var shipPose=mFromQT(A.quatAxisAngle(0,0,1,-(S?S.pitch:0)),sp2);
    drawParts(baseV,mFromQT([0,0,0,1],toRender(0,0,0)),
      clamp(TER.sunVisAt(A.BASE_AT[0],A.BASE_AT[1])+0.05,0,1),VP,cam.eye,baseDyn);
    drawParts(shipV,shipPose,shipLit(),VP,cam.eye,shipDyn);
    if(rov&&phase>=PH_EG){ var pm2=roverPoseM();
      drawParts(rovV,mFromQT(pm2.q,pm2.t),clamp(TER.sunVisAt(rov.x,rov.z)+0.05,0,1),VP,cam.eye,rovDyn); }
    if(S&&S.thr>0.03&&!S.landed) drawPlume(VP,shipPose,S.thr);
    /* dust */
    if(DUST&&DUST.live){
      dustUpload();
      gl.enable(gl.BLEND); gl.depthMask(false); gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(P.dust);
      gl.uniformMatrix4fv(UL.dust.VP,false,VP);
      gl.uniform1f(UL.dust.PS,52*Q.dpr);
      gl.uniform3f(UL.dust.Sun,SUN[0],SUN[1],SUN[2]);
      gl.uniform3f(UL.dust.Eye,cam.eye[0],cam.eye[1],cam.eye[2]);
      var fwd=vNorm(vSub(cam.tgt,cam.eye));
      gl.uniform3f(UL.dust.Fwd,fwd[0],fwd[1],fwd[2]);
      gl.uniform1f(UL.dust.SunIrr,SUN_IRR); gl.uniform1f(UL.dust.SunEl,SUN_EL);
      gl.uniform1i(UL.dust.Post,Q.post?1:0); gl.uniform1f(UL.dust.EV,evCPU);
      gl.bindVertexArray(DUST.vao); gl.drawArrays(gl.POINTS,0,DUST.n); DRAWS++;
      gl.depthMask(true); gl.disable(gl.BLEND);
    }
  } else {
    /* orbit / DOI / coast: the vehicle rendered against the limb */
    var alt=orbitCam().alt;
    var poseO=mFromQT(A.quatAxisAngle(0,0,1,Math.PI/2),[0,alt,0]);
    drawParts(shipV,poseO,1.0,VP,cam.eye,shipDyn);
    if(phase===PH_DOI) drawPlume(VP,poseO,0.82);
  }

  if(usePost) runPost();
  updateHUD();
  chartT+=rdt; if(chartT>0.45){ chartT=0; drawCharts(); }
  frameMs=performance.now()-t0;
  $('tDraw').textContent=DRAWS+' / '+(MESHSTAT.tris/1000).toFixed(0)+'k tri';
}

function runPost(){
  var RT=GFX.RT, PO=GFX.POST;
  gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
  gl.bindVertexArray(GFX.quadVao());
  /* auto-exposure: mip-reduce the scene, then a 1x1 ping-pong with temporal adaptation */
  gl.bindTexture(gl.TEXTURE_2D,RT.scene); gl.generateMipmap(gl.TEXTURE_2D);
  var src=RT.lumPing, dst=1-RT.lumPing;
  gl.bindFramebuffer(gl.FRAMEBUFFER,RT.lumFbo[dst]);
  gl.viewport(0,0,1,1);
  gl.useProgram(PO.lum);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D,RT.scene); gl.uniform1i(PO.lumU.Src,0);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D,RT.lum[src]); gl.uniform1i(PO.lumU.Prev,1);
  gl.uniform1f(PO.lumU.K,0.055);
  gl.drawArrays(gl.TRIANGLES,0,3); DRAWS++;
  RT.lumPing=dst;

  /* bloom: bright pass then separable blur, quarter res */
  gl.bindFramebuffer(gl.FRAMEBUFFER,RT.fboB);
  gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,RT.bloomA,0);
  gl.viewport(0,0,RT.bw,RT.bh);
  gl.useProgram(PO.bright);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D,RT.scene); gl.uniform1i(PO.brightU.Src,0);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D,RT.lum[dst]); gl.uniform1i(PO.brightU.Lum,1);
  gl.uniform1f(PO.brightU.Thresh,2.0); gl.uniform1f(PO.brightU.EVBias,EVman);
  gl.drawArrays(gl.TRIANGLES,0,3); DRAWS++;
  gl.useProgram(PO.blur);
  for(var p=0;p<2;p++){
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,RT.bloomB,0);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D,RT.bloomA); gl.uniform1i(PO.blurU.Src,0);
    gl.uniform2f(PO.blurU.Dir,1,0); gl.drawArrays(gl.TRIANGLES,0,3); DRAWS++;
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,RT.bloomA,0);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D,RT.bloomB); gl.uniform1i(PO.blurU.Src,0);
    gl.uniform2f(PO.blurU.Dir,0,1); gl.drawArrays(gl.TRIANGLES,0,3); DRAWS++;
  }

  /* composite */
  gl.bindFramebuffer(gl.FRAMEBUFFER,null);
  gl.viewport(0,0,cv.width,cv.height);
  gl.useProgram(PO.comp);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D,RT.scene); gl.uniform1i(PO.compU.Scene,0);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D,RT.bloomA); gl.uniform1i(PO.compU.Bloom,1);
  gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D,RT.lum[dst]); gl.uniform1i(PO.compU.LumT,2);
  gl.uniform1f(PO.compU.EVBias,EVman);
  gl.uniform1f(PO.compU.BloomAmt,0.022);
  gl.uniform1f(PO.compU.T,GMET);
  gl.uniform1f(PO.compU.Grain,0.016);
  gl.uniform1f(PO.compU.Vign,0.30);
  gl.uniform1f(PO.compU.CA,0.0016);
  gl.uniform1i(PO.compU.Post,0); gl.uniform1f(PO.compU.EV,0);
  gl.drawArrays(gl.TRIANGLES,0,3); DRAWS++;
  gl.enable(gl.DEPTH_TEST);
}

/* ---------- HUD ---------- */
function updateHUD(){
  $('tPhase').textContent=(phase===PH_DESC&&S)?A.phaseName(S):PHN[phase];
  $('met').textContent=A.fmtMET(GMET);
  $('tEv').textContent=(EVman>=0?'+':'')+EVman.toFixed(1)+' EV';
  var showOrb=phase<PH_DESC, showDes=(phase===PH_DESC||phase===PH_RAMP), showRov=(phase>=PH_EG&&rov);
  $('orbRows').classList.toggle('hide',!showOrb);
  $('desRows').classList.toggle('hide',!showDes);
  $('rovRows').classList.toggle('hide',!showRov);
  if(showOrb){
    var alt,vel;
    if(phase===PH_COAST){ alt=100000-(100000-A.ORB.hPeri)*smoo(coastU);
      vel=A.ORB.vApo+(A.ORB.vPeri-A.ORB.vApo)*smoo(coastU); }
    else { alt=100000; vel=A.ORB.vCirc-(A.ORB.vCirc-A.ORB.vApo)*clamp(doiU,0,1); }
    $('oAlt').textContent=(alt/1000).toFixed(1)+' km';
    $('oVel').textContent=vel.toFixed(0)+' m/s';
    $('oBurn').textContent=(phase===PH_ORB)?('T-'+Math.max(0,T_ORB-GMET).toFixed(0)+' s'):
      (phase===PH_DOI?'ACTIVE':'COAST '+((1-coastU)*A.ORB.tCoast/60).toFixed(0)+' min');
  }
  if(S&&showDes){
    var agl=S.h-groundY(S.x,0);
    $('tAlt').textContent=(agl>1000?(agl/1000).toFixed(2)+' km':agl.toFixed(agl<50?1:0)+' m');
    $('tAltN').textContent=S.nh.toFixed(S.nh<1000?1:0)+' m';
    $('tNavErr').textContent=(S.nh-S.h).toFixed(2)+' m alt · '+(S.nx-S.x).toFixed(1)+' m pos';
    $('tVs').textContent=S.vh.toFixed(2)+' m/s';
    $('tHs').textContent=S.vx.toFixed(S.vx>100?0:2)+' m/s';
    $('tPitch').textContent=(S.pitch*DEG).toFixed(1)+'° ('+(S.q*DEG).toFixed(1)+'°/s)';
    $('tThr').textContent=(S.thr*100).toFixed(0)+' % ← '+(S.thrCmd*100).toFixed(0)+'%';
    $('tThrBar').style.width=(S.thr*100).toFixed(0)+'%';
    $('tTwr').textContent=(S.T/(S.m*A.G_MOON)).toFixed(2);
    $('tTgo').textContent=S.landed?'—':Math.max(0,S.tgo).toFixed(0)+' s';
    var fuel=S.m-A.VEH.dry, ff=fuel/(A.VEH.m0-A.VEH.dry), fe=$('tFuel');
    fe.textContent=(fuel/1000).toFixed(2)+' t';
    fe.className='v '+(ff<0.06?'bad':(ff<0.15?'warn':''));
    $('tFuelBar').style.width=(ff*100).toFixed(0)+'%';
    $('tDv').textContent=S.dv.toFixed(0)+' / '+A.PLAN.dvCap.toFixed(0)+' m/s';
  }
  if(showRov){
    $('rSpd').textContent=rov.v.toFixed(2)+' m/s';
    $('rGrade').textContent=(rov.grade||0).toFixed(1)+'°';
    $('rOdo').textContent=(rov.odo/1000).toFixed(2)+' km';
    $('rTemp').textContent=TER.tempAt(rov.x,rov.z).toFixed(0)+' K';
    $('rIll').textContent=TER.illumAt(rov.x,rov.z).toFixed(3);
    $('rLampSt').textContent=lampOn?'ON':'off';
    $('rMode').textContent=manual?'MANUAL':'AUTO';
    var sc=A.scanTargets(rov.x,rov.z,ICE);
    $('scanConf').textContent=(sc.total*100).toFixed(0)+' %';
    $('scanBar').style.width=(sc.total*100).toFixed(0)+'%';
    if(sc.best){ var b=sc.best.dep;
      var brg=((Math.atan2(b.z-rov.z,b.x-rov.x)-rov.hdg)*DEG+540)%360-180;
      $('scanId').textContent=b.id+(found[sc.best.idx]?' ✓':'')+' · '+b.T.toFixed(0)+' K';
      $('scanRng').textContent=sc.best.dist.toFixed(0)+' m · '+(brg>=0?'R':'L')+Math.abs(brg).toFixed(0)+'°'; }
    $('rFound').textContent=found.filter(Boolean).length+' / '+ICE.length;
  }
}

/* ======================================================================================
   BOOT
   ====================================================================================== */
function boot(){
  ASSET=window.__DEM__;
  $('bootMsg').textContent='Decoding LOLA elevation model…';
  return A.decodeDEM(ASSET).then(function(dem){
    $('bootMsg').textContent='Ray-marching illumination and building terrain…';
    TER=A.makeTerrain(dem,ASSET);
    SUN_EL=ASSET.sunElDeg*RAD;
    SUN=vNorm([Math.cos(SUN_EL),Math.sin(SUN_EL),0]);
    ROUTE=A.buildRoute(ASSET,TER); ICE=A.buildIce(ASSET,TER);
    T_DOI=A.ORB.dvDOI/(0.82*A.VEH.Tmax/A.VEH.m0);
    $('bootMsg').textContent='Running two-stage dispersion analysis…';
    var st1=A.brakingDispersion(48,4253);
    MC=A.monteCarlo(220,777,TER,{aided:true,stage1:st1});
    MC_TRN=A.monteCarlo(220,777,TER,{aided:false,stage1:st1});
    $('bootMsg').textContent='Compiling shaders and uploading meshes…';
    GFX.buildPrograms();
    GFX.buildShadow();
    dem.elevPad=new Float32Array(dem.N*dem.N);
    for(var i=0;i<dem.N*dem.N;i++) dem.elevPad[i]=dem.elev[i]-ASSET.pad.elev;
    DEMTEX=GFX.uploadDem(dem,TER.vis);
    DEMA=[1/ASSET.px, 1/ASSET.px]; DEMB=[ASSET.pad.x, ASSET.pad.y];
    GRID=GFX.buildTerrainGrid(2.75e6);
    STARS=GFX.buildStars(); DISC=GFX.buildDiscQuad(); DUST=GFX.buildDust();
    shipV=makePartVaos(A.buildCargoShip());
    rovV=makePartVaos(A.buildRover());
    baseV=makePartVaos(A.buildBase());
    vPlume=GFX.vaoPNI(A.gCyl(0.34,1.30,3.2,16));
    MESHSTAT.tris=GRID.tris;
    window.__BOOT_OK__=true;
    fillProvenance();
    drawDispersion();
    $('tQual').textContent=Q.name+(Q.post?'':' · LDR');
    $('tVer').textContent=VERSION;
    $('bootMsg').textContent='';
    $('btnGo').classList.remove('hide');
    $('bootSpin').classList.add('hide');
    resize();
    resetMission();
    requestAnimationFrame(frame);
  });
}
function makePartVaos(parts){ var out=[];
  for(var i=0;i<parts.length;i++){ var p=parts[i];
    out.push({part:p,v:GFX.vaoPNI(p.geo),M:mFromQT(p.q,p.t)}); }
  return out; }

function fillProvenance(){
  $('provDem').textContent='LRO LOLA ldem_875s_5m · 5 m/px → '+ASSET.n+'² @ '+ASSET.px+' m';
  $('provSite').textContent=ASSET.pad.elev.toFixed(0)+' m · illum '+(ASSET.pad.ill*100).toFixed(0)+
    '% · slope '+ASSET.pad.slope.toFixed(1)+'°';
  $('provPsr').textContent=ASSET.psr.areaKm2.toFixed(1)+' km² · '+ASSET.psr.T.toFixed(0)+' K';
  $('provRoute').textContent=ASSET.routeStats.km.toFixed(2)+' km · '+ASSET.routeStats.drop.toFixed(0)+
    ' m · max '+ASSET.routeStats.maxGrade.toFixed(1)+'°';
  $('provMc').textContent=MC.n+' cases · 3σ ±'+(3*MC.x.sd).toFixed(0)+' m aided / ±'+
    (3*MC_TRN.x.sd).toFixed(0)+' m map-only · hard '+(MC.hardFrac*100).toFixed(1)+'%';
  $('provPlan').textContent='PDI '+(A.ORB.hPeri/1000).toFixed(1)+' km @ '+A.ORB.vPeri.toFixed(0)+
    ' m/s · ΔV '+A.PLAN.dvTotal.toFixed(0)+'/'+A.PLAN.dvCap.toFixed(0)+' m/s';
  var pctS=(MC.safeFrac*100).toFixed(1);
  $('tSafe').textContent=pctS+'%  ('+Math.round(MC.safeFrac*MC.n)+'/'+MC.n+')';
  $('tSafe').className='v '+(MC.safeFrac>0.9?'ok':(MC.safeFrac>0.7?'warn':'bad'));
  $('tGoNo').textContent=(MC.safeFrac>0.9?'GO':(MC.safeFrac>0.7?'MARGINAL':'NO-GO'));
  $('tGoNo').className='v '+(MC.safeFrac>0.9?'ok':(MC.safeFrac>0.7?'warn':'bad'));
  var domLbl={slope:'TERRAIN SLOPE',rough:'UNDULATION',vh:'VERT VELOCITY',
              vx:'LATERAL VEL',fuel:'FUEL MARGIN',shadow:'NO ILLUM'};
  $('tDom').textContent=MC.dom?(domLbl[MC.dom]+' ('+(MC.domN/MC.n*100).toFixed(0)+'%)'):'none';
  $('tDom').className='v '+(MC.dom?'warn':'ok');
  $('tSlope').textContent=MC.slope.mean.toFixed(1)+'° mean · '+MC.slope.max.toFixed(1)+
    '° worst  (lim '+MC.crit.slopeDeg+'°)';
  $('tRough').textContent=MC.rough.mean.toFixed(2)+' m mean · '+MC.rough.max.toFixed(2)+
    ' m worst  (lim '+MC.crit.undM.toFixed(2)+' m, pad '+(MC.crit.undCal||0).toFixed(2)+' m)';
}

$('btnGo').addEventListener('click',function(){
  $('start').classList.add('hide');
  ['tele','right','keys','log','mobbar'].forEach(function(id){ var e=$(id); if(e) e.classList.remove('hide'); });
  if(GFX.isMobile){ $('right').classList.add('hide'); }
  started=true; paused=false; lastRT=0; acc=0;
  window.__V7__={
    advance:function(dtWall){ if(paused||!started||!TER) return 0;
      acc+=dtWall*warp; var n=0, lim=MAXSUB*Math.max(1,warp);
      while(acc>=FIXED&&n<lim){ stepMission(FIXED); dustSpawn(FIXED); dustStep(FIXED); acc-=FIXED; n++; }
      if(acc>FIXED*40) acc=0; return n; },
    snapshot:function(){ return { gmet:+GMET.toFixed(6), phase:phase, mode:S?S.mode:null,
      S:S?{x:+S.x.toFixed(6),h:+S.h.toFixed(6),vx:+S.vx.toFixed(6),vh:+S.vh.toFixed(6),
           m:+S.m.toFixed(6),thr:+S.thr.toFixed(6),pitch:+S.pitch.toFixed(6)}:null,
      rov:(typeof rov!=='undefined'&&rov)?{x:+rov.x.toFixed(6),z:+rov.z.toFixed(6),
           hdg:+rov.hdg.toFixed(6),v:+rov.v.toFixed(6)}:null,
      ev:+evCPU.toFixed(3), draws:DRAWS }; },
    setWarp:function(w){ warp=w; autoWarp=false; },
    setCam:function(c){ camMode=c; camEyeS=null; $('tCam').textContent=CAMN[c]; },
    setVision:function(v){ vision=v; $('tVis').textContent=VISN[v]; } };
});
$('btnAgain').addEventListener('click',function(){ $('end').classList.add('hide'); });
$('btnProv').addEventListener('click',function(){ $('prov').classList.toggle('hide'); });
$('provClose').addEventListener('click',function(){ $('prov').classList.add('hide'); });
boot().catch(function(e){ window.showFatal('Boot failed: '+(e&&e.message?e.message:e)); });
})();
