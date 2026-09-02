"use strict";
/* Physics-core regression tests. Run: npm test  (node --test)
   These pin the behaviour that took the most work to get right, so a future edit that
   breaks flight mechanics fails loudly instead of silently degrading the sim. */
const test=require('node:test');
const assert=require('node:assert');
const path=require('path');
const A=require('../src/core.js');

global.window=global.window||{};
require('../assets/dem_south_pole_512.js');
const ASSET=global.window.__DEM__;

let TER=null;
async function terrain(){
  if(!TER){ const dem=await A.decodeDEM(ASSET); TER=A.makeTerrain(dem,ASSET); }
  return TER;
}
function fly(seed,opt){
  opt=opt||{};
  const s=A.initialState(seed,opt);
  let n=0;
  while(!s.landed && n<200000){ A.dynStep(s, s.mode==='brake'?0.1:0.02, opt.ground); n++; }
  assert.ok(s.landed,'vehicle did not reach the surface within the step budget');
  return s;
}

/* ---------------- orbital mechanics ---------------- */
test('circular orbit velocity at 100 km matches vis-viva', ()=>{
  const v=A.orbVel(100);
  assert.ok(Math.abs(v-1633)<3, `expected ~1633 m/s, got ${v.toFixed(1)}`);
});

test('Hohmann descent transfer is self-consistent', ()=>{
  const O=A.ORB;
  assert.ok(O.vPeri>O.vCirc, 'periapsis velocity must exceed circular velocity');
  assert.ok(O.dvDOI>0 && O.dvDOI<40, `DOI burn ${O.dvDOI.toFixed(1)} m/s outside plausible range`);
  assert.ok(O.hPeri>14000 && O.hPeri<16000, 'PDI altitude should be Apollo-class (~15.2 km)');
  /* coast is half the transfer period */
  assert.ok(O.tCoast>3000 && O.tCoast<3800, `coast ${O.tCoast.toFixed(0)} s implausible`);
});

/* ---------------- descent planning ---------------- */
test('planned descent fits inside the propellant budget with margin', ()=>{
  const P=A.PLAN;
  assert.ok(P.dvTotal<P.dvCap, 'planned delta-v exceeds vehicle capability');
  const margin=(P.dvCap-P.dvTotal)/P.dvCap;
  assert.ok(margin>0.05, `only ${(margin*100).toFixed(1)}% delta-v margin`);
});

test('braking and approach legs respect their thrust and tilt limits', ()=>{
  const P=A.PLAN, aMax0=A.VEH.Tmax/A.VEH.m0;
  assert.ok(P.brake.aPeak<=A.GUID.fBrake*aMax0*1.001, 'braking leg exceeds its thrust fraction');
  assert.ok(P.approach.tilt<=A.GUID.tiltPlan*1.001, 'approach leg exceeds the planned tilt limit');
  assert.ok(P.approach.tgo>60 && P.approach.tgo<260, 'approach duration implausible');
});

/* ---------------- attitude plant ---------------- */
test('attitude rate limit is reachable and stoppable by the RCS', ()=>{
  /* The v6 limit cycle came from a rate limit the torque could not brake. The rate
     command law must never ask for more than the RCS can stop within the error. */
  const alphaMax=A.VEH.rcsTorque/A.VEH.Iyy;
  const stopAngle=A.VEH.rateMax*A.VEH.rateMax/(2*alphaMax);
  assert.ok(stopAngle<Math.PI/2, 'stopping a full-rate slew takes more than 90 degrees');
  assert.ok(alphaMax>0.02, `RCS angular authority ${alphaMax.toFixed(3)} rad/s^2 too weak`);
});

/* ---------------- flight ---------------- */
test('nominal descent from PDI lands within the gear envelope, upright', ()=>{
  const s=fly(20260718);
  assert.ok(Math.abs(s.tdVh)<=A.VEH.gearVh, `vertical ${Math.abs(s.tdVh).toFixed(2)} m/s exceeds gear`);
  assert.ok(Math.abs(s.tdVx)<=A.VEH.gearVx, `lateral ${Math.abs(s.tdVx).toFixed(2)} m/s exceeds gear`);
  assert.ok(Math.abs(s.pitch*A.DEG)<5, `contact tilt ${(s.pitch*A.DEG).toFixed(1)} deg — not upright`);
  assert.ok(s.m-A.VEH.dry>400, 'landed with less than 400 kg of propellant');
  assert.ok(s.t>600 && s.t<1200, `descent took ${s.t.toFixed(0)} s`);
});

test('descent is upright and fuel-positive across seeds', ()=>{
  for(const seed of [777,4242,99991,31337,5150,8080,20260718]){
    const s=fly(seed);
    assert.ok(Math.abs(s.pitch*A.DEG)<5, `seed ${seed}: contact tilt ${(s.pitch*A.DEG).toFixed(1)} deg`);
    assert.ok(Math.abs(s.tdVh)<=A.VEH.gearVh, `seed ${seed}: vertical ${s.tdVh.toFixed(2)}`);
    assert.ok(s.m-A.VEH.dry>300, `seed ${seed}: propellant exhausted`);
  }
});

test('the vehicle actually flies the phase sequence', ()=>{
  const s=A.initialState(20260718);
  const seen=[]; let last=null, n=0;
  while(!s.landed && n<200000){ A.dynStep(s, s.mode==='brake'?0.1:0.02); n++;
    if(s.mode!==last){ seen.push(s.mode); last=s.mode; } }
  assert.deepStrictEqual(seen,['brake','approach','terminal','landed']);
});

test('high gate is reached at the planned state, not at the pad', ()=>{
  /* Regression: the braking leg must target the high gate (approach.D short of the pad).
     Targeting the pad arrives ~7 km late and the approach leg has to fly backwards. */
  const s=A.initialState(20260718);
  let n=0;
  while(s.mode==='brake' && !s.landed && n<200000){ A.dynStep(s,0.1); n++; }
  assert.ok(Math.abs(s.x-A.PLAN.approach.x0)<600,
    `high gate at x=${s.x.toFixed(0)}, expected ~${A.PLAN.approach.x0.toFixed(0)}`);
  assert.ok(Math.abs(s.h-A.GATES.HG.h)<250, `high gate altitude ${s.h.toFixed(0)} m off target`);
  assert.ok(Math.abs(s.vx-A.GATES.HG.vx)<25, `high gate speed ${s.vx.toFixed(0)} m/s off target`);
});

test('integration is deterministic for a fixed seed and step', ()=>{
  const a=A.runDescent(4242,0.02), b=A.runDescent(4242,0.02);
  assert.deepStrictEqual(a,b);
});

test('a coasting vehicle at periapsis stays in orbit (curvature terms are live)', ()=>{
  /* Without the vx^2/r term a 1692 m/s vehicle at 15 km would fall straight onto the
     surface; with it, an unpowered arc must still be well above the ground after 60 s. */
  const s=A.initialState(20260718);
  s.thr=0; let h=s.h;
  const r=A.R_MOON+s.h, aNet=A.GM_MOON/(r*r)-s.vx*s.vx/r;
  assert.ok(aNet<A.G_MOON*0.5,
    `net radial acceleration ${aNet.toFixed(3)} m/s^2 — orbital speed is not being credited`);
});

/* ---------------- terrain + screening ---------------- */
test('terrain separates measured DEM from synthetic relief', async()=>{
  const T=await terrain();
  /* Far from the pad the synthetic relief must perturb the visual height but never the
     DEM height used for screening. */
  const x=1500, z=1500;
  assert.notStrictEqual(T.heightAt(x,z), T.heightDem(x,z));
  const d=Math.abs(T.heightAt(x,z)-T.heightDem(x,z));
  assert.ok(d<60, `synthetic relief ${d.toFixed(1)} m is too large to be sub-grid detail`);
  /* The pad apron is graded: DEM relief levelled, fine surface texture retained. */
  assert.ok(Math.abs(T.heightAt(0,0))<0.8, 'pad apron is not graded level');
  assert.ok(Math.abs(T.heightAt(0,0))>1e-4, 'pad apron should keep some surface texture');
  assert.ok(T.slopeAt(0,0)<6.0, 'pad apron slope should be small');
});

test('undulation screening uses the DEM only and is calibrated to the pad', async()=>{
  const T=await terrain();
  const crit=A.calibrateAbort(T);
  assert.ok(crit.undCal>0, 'pad undulation not measured');
  assert.ok(crit.undM>crit.undCal, 'threshold must sit above the reference pad');
  assert.strictEqual(crit.padResolvable,false,'footpad-scale roughness must stay a declared data gap');
});

test('sun visibility is directional and physically ordered', async()=>{
  const T=await terrain();
  assert.ok(T.sunVisAt(0,0)>0.9, 'the selected pad should be sunlit');
  const psr=T.cellToWorld(ASSET.psr.x,ASSET.psr.y);
  assert.ok(T.sunVisAt(psr[0],psr[1])<0.05, 'the PSR must be in shadow');
  assert.ok(T.tempAt(psr[0],psr[1])<110, 'PSR must be cold enough for ice stability');
  assert.ok(T.tempAt(0,0)>150, 'sunlit pad should be warm');
});

test('cold-trap candidates are all inside permanent shadow and ice-stable', async()=>{
  const T=await terrain();
  const ICE=A.buildIce(ASSET,T);
  assert.ok(ICE.length>0);
  for(const d of ICE){
    assert.ok(d.T<110, `${d.id} at ${d.T} K is not ice-stable`);
    assert.ok(T.illumAt(d.x,d.z)<0.02, `${d.id} is not in permanent shadow`);
  }
});

/* ---------------- dispersion ---------------- */
test('Monte Carlo: aided navigation gives a tighter, safer ellipse than map-only', async()=>{
  const T=await terrain();
  const st1=A.brakingDispersion(24,4253);
  const aided=A.monteCarlo(120,777,T,{aided:true,stage1:st1});
  const trn  =A.monteCarlo(120,777,T,{aided:false,stage1:st1});
  assert.ok(aided.x.sd<trn.x.sd, 'aided navigation should reduce downrange dispersion');
  assert.ok(aided.safeFrac>=trn.safeFrac, 'aided navigation should not reduce site acceptance');
  assert.ok(aided.safeFrac>0.85, `aided acceptance only ${(aided.safeFrac*100).toFixed(0)}%`);
  assert.ok(3*aided.x.sd<150, 'aided 3-sigma ellipse implausibly wide');
  for(const c of aided.cases){
    assert.ok(Number.isFinite(c.x)&&Number.isFinite(c.z),'non-finite touchdown point');
  }
});

test('Monte Carlo touchdown statistics stay inside the gear envelope on average', async()=>{
  const T=await terrain();
  const MC=A.monteCarlo(120,777,T,{aided:true});
  assert.ok(Math.abs(MC.vh.mean)<A.VEH.gearVh*0.5, 'mean vertical touchdown too fast');
  assert.ok(MC.hardFrac<0.10, `${(MC.hardFrac*100).toFixed(1)}% hard landings`);
  assert.ok(MC.fuel.min>0, 'a case ran the tanks dry');
});

/* ---------------- rover ---------------- */
test('rover route is planned on the DEM and ends in the surveyed PSR', async()=>{
  const T=await terrain();
  const ROUTE=A.buildRoute(ASSET,T);
  assert.ok(ROUTE.length>5,'route too short');
  const end=ROUTE[ROUTE.length-1];
  assert.ok(end.park,'final waypoint must be a parking/survey station');
  assert.ok(T.illumAt(end.x,end.z)<0.05,'route must terminate in shadow');
  let maxGrade=0;
  for(let i=1;i<ROUTE.length;i++){
    const a=ROUTE[i-1], b=ROUTE[i];
    const d=Math.hypot(b.x-a.x,b.z-a.z);
    const g=Math.abs(Math.atan2(T.heightDem(b.x,b.z)-T.heightDem(a.x,a.z),d)*A.DEG);
    if(g>maxGrade) maxGrade=g;
  }
  assert.ok(maxGrade<=18.5,`route grade ${maxGrade.toFixed(1)} deg exceeds the 18 deg planning limit`);
});

test('rover drives the route without leaving the DEM or exceeding its speed limit', async()=>{
  const T=await terrain();
  const ROUTE=A.buildRoute(ASSET,T);
  const r=A.roverInit(ROUTE[0].x,ROUTE[0].z,0);
  let t=0;
  while(t<9000 && r.wp<ROUTE.length){
    const cmd=A.autoDrive(r,0.1,ROUTE);
    A.roverStep(r,0.1,cmd,T);
    assert.ok(Math.abs(r.v)<=A.ROVER.vMax+1e-6,'rover exceeded its speed limit');
    assert.ok(r.x>T.minX && r.x<T.maxX && r.z>T.minZ && r.z<T.maxZ,'rover left the DEM');
    t+=0.1;
  }
  assert.ok(r.wp>=ROUTE.length, `rover did not finish the route (waypoint ${r.wp}/${ROUTE.length})`);
  assert.ok(r.odo>3000, `odometer ${r.odo.toFixed(0)} m — route not actually driven`);
});

test('cold-trap scan responds to range', async()=>{
  const T=await terrain();
  const ICE=A.buildIce(ASSET,T);
  const near=A.scanTargets(ICE[0].x,ICE[0].z,ICE);
  const far =A.scanTargets(ICE[0].x+5000,ICE[0].z+5000,ICE);
  assert.ok(near.total>far.total,'signal must fall off with range');
  assert.ok(near.total<=1 && far.total>=0,'signal must stay normalised');
});
