// Exercise the real hook with synthetic browser media; never capture or connect.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createVoiceInput,voiceActivityEvent} from '../renderer/src/manager/voice-input.js';
import {createCallCues} from '../renderer/src/manager/sounds.js';
import {createSilentAudio} from '../renderer/src/manager/voice-silence.js';
const source=(await readFile(new URL('../renderer/src/manager/useVoiceSession.js',import.meta.url),'utf8')).replace(/^import .*;\s*$/gm,'').replace('export function useVoiceSession','function useVoiceSession');
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function track(){return {enabled:true,readyState:'live',stopCount:0,stop(){this.enabled=false;this.readyState='ended';this.stopCount++;},end(){this.readyState='ended';this.onended?.();}};}
function stream(){const audio=track();return {audio,getTracks:()=>[audio],getAudioTracks:()=>[audio]};}
class Events{
 listeners=new Map();visibilityState='visible';
 addEventListener(type,handler){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type).add(handler);}
 removeEventListener(type,handler){this.listeners.get(type)?.delete(handler);}
 emit(type){for(const handler of this.listeners.get(type)||[])handler({type});}
 count(){return [...this.listeners.values()].reduce((sum,handlers)=>sum+handlers.size,0);}
}
function harness({acquire,replaceTrack}={}){
 const cells=[],effects=[],connections=[],captures=[],audioContexts=[],requests=[],errors=[],sounds=[],timers=new Map();
 const window=new Events(),document=new Events();let cursor=0,dirty=false,disposed=false,current,timerId=0;
 const depsSame=(a,b)=>Boolean(a&&b&&a.length===b.length&&a.every((value,index)=>Object.is(value,b[index])));
 const useRef=initial=>{const index=cursor++;return cells[index]??(cells[index]={current:initial});};
 const useState=initial=>{const index=cursor++;if(!cells[index])cells[index]={value:typeof initial==='function'?initial():initial};return [cells[index].value,value=>{if(disposed)return;cells[index].value=typeof value==='function'?value(cells[index].value):value;dirty=true;}];};
 const useCallback=(callback,deps)=>{const index=cursor++;if(!cells[index]||!depsSame(cells[index].deps,deps))cells[index]={callback,deps};return cells[index].callback;};
 const useEffect=(effect,deps)=>{const index=cursor++;if(!cells[index]||!depsSame(cells[index].deps,deps)){const previous=cells[index];cells[index]={deps,cleanup:previous?.cleanup};effects.push(()=>{previous?.cleanup?.();cells[index].cleanup=effect();});}};
 class AudioContext{
  state='suspended';
  constructor(){this.media=stream();audioContexts.push(this);}
  createMediaStreamDestination(){return {stream:this.media};}
  createConstantSource(){return {offset:{value:1},connect(){},start(){},stop(){},disconnect(){}};}
  async resume(){this.state='running';}
  async close(){this.state='closed';}
 }
 class Peer{
  connectionState='new';iceConnectionState='new';localDescription=null;closed=false;
  sender={replacements:[],replaceTrack:async value=>{this.sender.replacements.push(value);if(replaceTrack)await replaceTrack(value);this.sender.track=value;}};
  constructor(){connections.push(this);}
  addTransceiver(value){this.sender.track=value;return {sender:this.sender};}
  createDataChannel(){return {readyState:'open',onmessage:null};}
  async createOffer(){return {type:'offer',sdp:'v=0\r\nsynthetic-offer'};}
  async setLocalDescription(value){this.localDescription=value;}
  async setRemoteDescription(){this.connectionState='connecting';}
  async getStats(){return new Map();}
  emit(state='connected'){this.connectionState=state;this.onconnectionstatechange?.();}
  close(){this.closed=true;this.connectionState='closed';}
 }
 const context=vm.createContext({useRef,useState,useCallback,useEffect,createVoiceInput,voiceActivityEvent,createCallCues,createSilentAudio:()=>createSilentAudio(AudioContext),navigator:{mediaDevices:{getUserMedia:async constraints=>{captures.push(constraints);return acquire?acquire(captures.length):stream();}}},RTCPeerConnection:Peer,window,document,api:async(route,input)=>{requests.push({route,input});return route==='connect'?{sessionToken:'synthetic-session',sdp:'v=0\r\nsynthetic-answer'}:{};},errorText:error=>String(error?.message||error),setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},setInterval:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id),clearInterval:id=>timers.delete(id)});
 vm.runInContext(source+'\nglobalThis.voiceHook=useVoiceSession;',context,{filename:'useVoiceSession.js'});
 const soundPlayer={play:kind=>sounds.push(kind),unlock(){}};
 function render(){cursor=0;dirty=false;current=context.voiceHook(error=>errors.push(error),soundPlayer);while(effects.length)effects.shift()();return current;}
 render();
 async function flush(){for(let round=0;round<12;round++){await Promise.resolve();if(dirty)render();}}
 return {get voice(){if(dirty)render();return current;},window,document,connections,captures,audioContexts,requests,errors,sounds,timers,flush,
  async connect(){await this.voice.connect('synthetic-voice');await flush();return connections.at(-1);},
  destroy(){for(const cell of cells)cell?.cleanup?.();disposed=true;timers.clear();},
 };
}
async function connected(h){const peer=await h.connect();peer.emit();await h.flush();return peer;}

test('default open microphone captures once only after connection, despite repeated connected events',async t=>{
 const h=harness();t.after(()=>h.destroy());assert.equal(h.voice.mode,'open-mic');assert.equal(h.captures.length,0);
 const peer=await h.connect();assert.equal(h.captures.length,0);assert.equal(h.voice.active,false);
 peer.emit();await h.flush();assert.equal(h.captures.length,1);assert.equal(h.voice.transmitting,true);assert.equal(peer.sender.track.enabled,true);
 peer.emit();peer.emit();await h.flush();assert.equal(h.captures.length,1);assert.equal(h.requests.filter(request=>request.route==='voice-ready').length,1);
});
test('established open microphone survives blur and hidden; PTT stops on either and never captures on Connect',async t=>{
 const open=harness();t.after(()=>open.destroy());const peer=await connected(open),mic=peer.sender.track;
 open.window.emit('blur');open.document.visibilityState='hidden';open.document.emit('visibilitychange');await open.flush();assert.equal(mic.readyState,'live');assert.equal(open.voice.transmitting,true);
 const ptt=harness();t.after(()=>ptt.destroy());ptt.voice.changeMode('push-to-talk');await ptt.flush();const held=await connected(ptt);assert.equal(ptt.captures.length,0);
 ptt.voice.startInput();await ptt.flush();const first=held.sender.track;assert.equal(ptt.voice.transmitting,true);
 ptt.window.emit('blur');await ptt.flush();assert.equal(first.readyState,'ended');assert.equal(ptt.voice.transmitting,false);
 ptt.voice.startInput();await ptt.flush();const second=held.sender.track;ptt.document.visibilityState='hidden';ptt.document.emit('visibilitychange');await ptt.flush();assert.equal(second.readyState,'ended');assert.equal(ptt.voice.transmitting,false);
});
test('explicit mute remains across normal disconnect/reconnect and transport loss/reconnect',async t=>{
 const h=harness();t.after(()=>h.destroy());await connected(h);h.voice.toggleMute();await h.flush();assert.equal(h.voice.openMicMuted,true);
 await h.voice.disconnect();await h.flush();await connected(h);assert.equal(h.captures.length,1);assert.equal(h.voice.transmitting,false);assert.equal(h.voice.openMicMuted,true);
 h.voice.transportLost();await h.flush();await connected(h);assert.equal(h.captures.length,1);assert.equal(h.voice.openMicMuted,true);
 h.voice.toggleMute();await h.flush();assert.equal(h.captures.length,2);assert.equal(h.voice.transmitting,true);
});
test('permission denial is reported once with no repeated-event retry; explicit microphone action retries',async t=>{
 const denied=Object.assign(new Error('synthetic denied'),{name:'NotAllowedError'});
 const h=harness({acquire:count=>count===1?Promise.reject(denied):stream()});t.after(()=>h.destroy());const peer=await connected(h);
 assert.match(h.voice.inputError,/permission was denied/);assert.equal(h.voice.transmitting,false);peer.emit();peer.emit();await h.flush();assert.equal(h.captures.length,1);
 h.voice.toggleMute();await h.flush();assert.equal(h.captures.length,2);assert.equal(h.voice.transmitting,true);assert.equal(h.voice.inputError,'');
});
test('mute during pending permission invalidates late capture and remains muted on reconnect',async t=>{
 const permission=deferred(),late=stream(),h=harness({acquire:()=>permission.promise});t.after(()=>h.destroy());await connected(h);assert.equal(h.voice.inputPending,true);
 h.voice.toggleMute();await h.flush();permission.resolve(late);await h.flush();assert.equal(late.audio.readyState,'ended');assert.equal(h.voice.transmitting,false);assert.equal(h.voice.openMicMuted,true);
 await h.voice.disconnect();await h.flush();await connected(h);assert.equal(h.captures.length,1);
});
test('disconnect cancels pending permission; a late grant cannot attach to a replacement call',async t=>{
 const permission=deferred(),late=stream(),h=harness({acquire:count=>count===1?permission.promise:stream()});t.after(()=>h.destroy());const old=await connected(h);
 await h.voice.disconnect();await h.flush();const next=await connected(h);assert.equal(h.voice.transmitting,true);const currentMic=next.sender.track;
 permission.resolve(late);await h.flush();assert.equal(late.audio.readyState,'ended');assert.equal(old.closed,true);assert.equal(next.sender.track,currentMic);assert.equal(currentMic.readyState,'live');assert.equal(h.voice.transmitting,true);
});
test('mute while replaceTrack is pending never enables the acquired microphone afterward',async t=>{
 const attachment=deferred(),mic=stream(),h=harness({acquire:()=>mic,replaceTrack:value=>value===mic.audio?attachment.promise:undefined});t.after(()=>h.destroy());const peer=await connected(h);
 assert.equal(mic.audio.enabled,false);assert.equal(h.voice.inputPending,true);h.voice.toggleMute();await h.flush();assert.equal(mic.audio.readyState,'ended');
 attachment.resolve();await h.flush();assert.equal(mic.audio.enabled,false);assert.equal(h.voice.transmitting,false);assert.notEqual(peer.sender.track,mic.audio);
});
test('page destruction releases physical and silent tracks, closes peer and removes listeners',async()=>{
 const h=harness();const peer=await connected(h),mic=peer.sender.track,silent=h.audioContexts[0].media.audio;assert.ok(h.window.count()>0);
 h.destroy();await h.flush();assert.equal(mic.readyState,'ended');assert.equal(silent.readyState,'ended');assert.equal(h.audioContexts[0].state,'closed');assert.equal(peer.closed,true);assert.equal(h.window.count(),0);assert.equal(h.document.count(),0);assert.equal(h.timers.size,0);
});

test('canceling a connecting call makes its stale connected callback unable to capture',async t=>{
 const h=harness();t.after(()=>h.destroy());const peer=await h.connect(),lateConnected=peer.onconnectionstatechange;
 await h.voice.disconnect();await h.flush();peer.connectionState='connected';lateConnected();await h.flush();
 assert.equal(h.captures.length,0);assert.equal(h.voice.active,false);assert.equal(peer.closed,true);
});
test('device-ended input cannot be recaptured by transport events, and an error preserves explicit mute',async t=>{
 const h=harness();t.after(()=>h.destroy());const peer=await connected(h);peer.sender.track.end();await h.flush();assert.equal(h.voice.transmitting,false);assert.match(h.voice.inputError,/disconnected/);
 peer.emit();await h.flush();assert.equal(h.captures.length,1);
 h.voice.toggleMute();await h.flush();assert.equal(h.captures.length,2);h.voice.toggleMute();await h.flush();
 h.voice.handleEvent({type:'error',message:'synthetic transport failure'});await h.flush();await connected(h);
 assert.equal(h.captures.length,2);assert.equal(h.voice.openMicMuted,true);assert.equal(h.voice.transmitting,false);
});

// Integration assertions exercise cue timing in the actual voice hook.
test('real hook cues deduplicate connection/end and wait for successful explicit unmute',async t=>{
 const h=harness();t.after(()=>h.destroy());const peer=await connected(h);
 peer.emit();await h.flush();assert.deepEqual(h.sounds,['connected']);
 h.voice.toggleMute();await h.flush();assert.deepEqual(h.sounds,['connected','muted']);
 h.voice.toggleMute();await h.flush();assert.deepEqual(h.sounds,['connected','muted','unmuted']);
 await h.voice.disconnect();await h.flush();h.voice.handleEvent({type:'closed'});await h.flush();
 assert.deepEqual(h.sounds,['connected','muted','unmuted','ended']);
});
test('real hook stays quiet for denied and canceled unmute and cancellation before connection',async t=>{
 const denied=deferred(),h=harness({acquire:()=>denied.promise});t.after(()=>h.destroy());
 await connected(h);h.voice.toggleMute();await h.flush();
 h.voice.toggleMute();await h.flush();denied.reject(new Error('denied'));await h.flush();
 assert.deepEqual(h.sounds,['connected']);
 await h.voice.disconnect();await h.flush();
 const p=await h.connect();await h.voice.disconnect();p.emit();await h.flush();
 assert.deepEqual(h.sounds,['connected','ended']);
});
