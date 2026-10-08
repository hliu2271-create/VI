'use strict';
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const events={},viewportEvents={},classes=new Set();
 const input=()=>({tagName:'INPUT',matches:selector=>selector.includes('input')});
 const document={readyState:'complete',activeElement:input(),addEventListener:(name,fn)=>events[name]=fn,querySelectorAll:()=>[],documentElement:{classList:{toggle:(name,on)=>on?classes.add(name):classes.delete(name)}}};
 const viewport={height:800,addEventListener:(name,fn)=>viewportEvents[name]=fn};
 const window={};const context={window,parent:window,document,visualViewport:viewport,innerHeight:800,innerWidth:390,matchMedia:()=>({matches:true}),addEventListener(){},queueMicrotask,location:{origin:'https://example.test'}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../frontend/mobile-VI.js'),'utf8'),context);
 events.focusin();viewport.height=450;viewportEvents.resize();assert(classes.has('mobile-keyboard-open'));
 events.focusout();document.activeElement=input();events.focusin();await Promise.resolve();assert(classes.has('mobile-keyboard-open'),'Input-to-input focus must retain hidden video while keyboard remains open');
 viewport.height=800;viewportEvents.resize();assert(!classes.has('mobile-keyboard-open'));
 console.log('PASS: keyboard resize, input-to-input transition and restoration (simulated viewport).');
})().catch(e=>{console.error(e.message);process.exitCode=1;});
