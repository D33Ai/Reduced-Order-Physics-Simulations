#!/usr/bin/env node
"use strict";
/* Headless validation: boots the built bundle in Chromium, confirms every shader compiles
   and links, advances the mission deterministically through each phase, and captures a
   frame per phase on both the desktop and mobile paths.
   Usage: node test/headless.js [--mobile] [--out DIR] [--keep] */
const path=require('path'), fs=require('fs');
const PW=require(process.env.PLAYWRIGHT_PATH||'/opt/node22/lib/node_modules/playwright');
const zlib=require('zlib');

/* Minimal 8-bit PNG reader so frames can be checked for real. The canvas itself reads back
   as zeros (preserveDrawingBuffer is off), so the screenshot is the only honest source. */
function pngStats(buf){
  let p=8, w=0, h=0, ct=6, idat=[];
  while(p<buf.length){
    const len=buf.readUInt32BE(p), type=buf.toString('ascii',p+4,p+8);
    if(type==='IHDR'){ w=buf.readUInt32BE(p+8); h=buf.readUInt32BE(p+12); ct=buf[p+17]; }
    else if(type==='IDAT') idat.push(buf.slice(p+8,p+8+len));
    else if(type==='IEND') break;
    p+=12+len;
  }
  const ch=(ct===6)?4:(ct===2?3:1);
  const raw=zlib.inflateSync(Buffer.concat(idat));
  const stride=w*ch, out=Buffer.alloc(h*stride);
  let o=0, ip=0;
  for(let y=0;y<h;y++){
    const f=raw[ip++];
    for(let x=0;x<stride;x++){
      const a=x>=ch?out[o+x-ch]:0, b=y>0?out[o-stride+x]:0, c=(x>=ch&&y>0)?out[o-stride+x-ch]:0;
      const v=raw[ip++];
      let r;
      if(f===0) r=v; else if(f===1) r=v+a; else if(f===2) r=v+b;
      else if(f===3) r=v+((a+b)>>1);
      else { const pa=Math.abs(b-c), pb=Math.abs(a-c), pc=Math.abs(a+b-2*c);
             r=v+((pa<=pb&&pa<=pc)?a:(pb<=pc?b:c)); }
      out[o+x]=r&255;
    }
    o+=stride;
  }
  let sum=0, mx=0, n=0, nonzero=0;
  for(let y=0;y<h;y+=3) for(let x=0;x<w;x+=3){
    const i=y*stride+x*ch, l=(out[i]+out[i+1]+out[i+2])/3;
    sum+=l; n++; if(l>mx)mx=l; if(l>3) nonzero++;
  }
  return {w,h,mean:sum/n, max:mx, litFrac:nonzero/n};
}

const argv=process.argv.slice(2);
const mobile=argv.includes('--mobile');
const outDir=path.resolve((()=>{ const i=argv.indexOf('--out'); return i>=0?argv[i+1]:'shots'; })());
const FILE=path.resolve(__dirname,'..','dist','lunar_cargo_mission_v7.html');

/* phase -> what to do next. Each step advances simulated seconds, then screenshots. */
/* Driven at warp 1, so `adv` is simulated seconds. Step 1 pins the warp, which also
   disables the mission's auto-warp so the timeline below stays deterministic. */
const PLAN=[
  {warp:1, adv:6,   name:'orbit',       expect:{phase:0}},
  {adv:11,          name:'doi_burn',    expect:{phase:1}},
  {adv:8,           name:'coast',       expect:{phase:2}},
  {adv:12,          name:'pdi',         expect:{phase:3, mode:'brake'}},
  {adv:200,         name:'braking',     expect:{mode:'brake'}},
  {cam:2, adv:400,  name:'braking_onboard', expect:{mode:'brake'}},
  {cam:0, adv:180,  name:'high_gate',   expect:{mode:['approach','terminal']}},
  {cam:1, adv:78,   name:'landing_burn', expect:{mode:['approach','terminal']}},
  {cam:0, adv:22,   name:'terminal',    expect:{mode:['terminal','landed']}},
  {adv:40,          name:'touchdown',   expect:{mode:'landed'}},
  {adv:30,          name:'ramp',        expect:{phase:[4,5,6]}},
  {adv:40,          name:'egress',      expect:{phase:[5,6]}},
  {cam:1, adv:120,  name:'lander_wide', expect:{phase:6}},
  {cam:0, adv:1800, name:'traverse'},
  {adv:2200,        name:'crater_wall'},
  {cam:3, adv:1400, name:'rover_chase'},
  {vision:1, adv:4, name:'nightvision'},
  {vision:2, adv:4, name:'thermal'},
  {vision:0, cam:4, adv:4, name:'rover_pov'}
];

(async()=>{
  fs.mkdirSync(outDir,{recursive:true});
  const browser=await PW.chromium.launch({args:[
    '--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
  const ctx=await browser.newContext({
    viewport: mobile?{width:390,height:844}:{width:1280,height:800},
    deviceScaleFactor:1,
    userAgent: mobile?'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1':undefined});
  const page=await ctx.newPage();
  const errs=[];
  page.on('pageerror',e=>errs.push('pageerror: '+e.message));
  page.on('console',m=>{ if(m.type()==='error') errs.push('console: '+m.text()); });

  const t0=Date.now();
  await page.goto('file://'+FILE);
  try{ await page.waitForFunction(()=>window.__BOOT_OK__===true,{timeout:120000}); }
  catch(e){
    const msg=await page.evaluate(()=>document.getElementById('glErr').textContent);
    fail('boot failed: '+(msg||e.message));
  }
  const bootMs=Date.now()-t0;
  const glErr=await page.evaluate(()=>document.getElementById('glErr').textContent);
  if(glErr) fail('fault card shown after boot: '+glErr);
  console.log(`[${mobile?'mobile':'desktop'}] boot ok in ${bootMs} ms`);

  await page.screenshot({path:path.join(outDir,'00_start.png')});
  await page.click('#btnGo');
  await page.waitForFunction(()=>!!window.__V7__,{timeout:10000});

  let i=1; const frames=[];
  for(const step of PLAN){
    if(step.cam!==undefined)    await page.evaluate(c=>window.__V7__.setCam(c),step.cam);
    if(step.vision!==undefined) await page.evaluate(v=>window.__V7__.setVision(v),step.vision);
    if(step.warp!==undefined)   await page.evaluate(w=>window.__V7__.setWarp(w),step.warp);
    if(step.adv){
      await page.evaluate(s=>{ const P=window.__V7__; let t=0;
        while(t<s){ P.advance(1/30); t+=1/30; } },step.adv);
    }
    await page.waitForTimeout(220);
    const snap=await page.evaluate(()=>window.__V7__.snapshot());
    const name=String(i).padStart(2,'0')+'_'+step.name;
    const png=await page.screenshot({path:path.join(outDir,name+'.png')});
    const st=pngStats(png);
    frames.push({name,st});
    console.log(' ',name.padEnd(22),
      'ph='+snap.phase, (snap.mode||'-').padEnd(9),
      (snap.S?('h='+snap.S.h.toFixed(0).padStart(6)+' x='+(snap.S.x/1000).toFixed(1).padStart(7)+'km thr='+snap.S.thr.toFixed(2)):'').padEnd(34),
      (snap.rov?('rov='+snap.rov.x.toFixed(0)+','+snap.rov.z.toFixed(0)):'').padEnd(18),
      'lum='+st.mean.toFixed(1).padStart(5)+'/'+st.max.toFixed(0).padStart(3),
      'lit='+(st.litFrac*100).toFixed(0)+'%',
      'draws='+snap.draws);
    if(step.expect){
      for(const [k,v] of Object.entries(step.expect)){
        const got=snap[k], ok=Array.isArray(v)?v.includes(got):got===v;
        if(!ok) fail(`at ${name}: expected ${k}=${JSON.stringify(v)}, got ${JSON.stringify(got)}`);
      }
    }
    i++;
  }

  /* the mission must have reached the surface and logged cold traps */
  const final=await page.evaluate(()=>({
    snap:window.__V7__.snapshot(),
    found:document.getElementById('rFound').textContent,
    phaseTxt:document.getElementById('tPhase').textContent,
    log:document.getElementById('log').innerText
  }));
  if(final.snap.phase<6) fail('mission never reached surface ops (phase '+final.snap.phase+')');
  if(!/TOUCHDOWN/.test(final.log)) fail('no touchdown in the mission log');
  console.log('  final phase:',final.phaseTxt,'· cold traps logged:',final.found);

  /* No frame may be a silent black screen — that is a failure, not a pass. The HUD alone
     lights a few percent of the frame, so require real scene content beyond it. */
  const dark=frames.filter(f=>f.st.max<24 || f.st.litFrac<0.10);
  if(dark.length) fail('frames with no visible scene: '+dark.map(f=>f.name+
    ' (max '+f.st.max.toFixed(0)+', lit '+(f.st.litFrac*100).toFixed(0)+'%)').join(', '));

  if(errs.length){
    console.log('  page errors:'); errs.slice(0,20).forEach(e=>console.log('   ',e));
    fail(errs.length+' page error(s)');
  }
  console.log(`[${mobile?'mobile':'desktop'}] PASS — frames in ${path.relative(process.cwd(),outDir)}`);
  await browser.close();

  function fail(msg){ console.error('FAIL: '+msg); if(errs.length) errs.slice(0,10).forEach(e=>console.error('  '+e));
    browser.close().then(()=>process.exit(1)); throw new Error(msg); }
})().catch(e=>{ console.error(e.message||e); process.exit(1); });
