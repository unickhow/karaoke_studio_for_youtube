const fs = require('fs');
const vm = require('vm');
let Processor = null;
const ctx = {AudioWorkletProcessor:class {},sampleRate:48000,registerProcessor:(name,cls)=>{Processor=cls},Float32Array,Math};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(__dirname + '/extension/pitch-worklet.js','utf8'),ctx);
function test(st) {
 const proc=new Processor();
 const result=[];
 for(let t=0;t<48000*2;t+=128){
  const input=[new Float32Array(128),new Float32Array(128)];
  const output=[new Float32Array(128),new Float32Array(128)];
  for(let k=0;k<128;k++) input[0][k]=input[1][k]=Math.sin(2*Math.PI*440*(t+k)/48000)*0.7;
  proc.process([input],[output],{semitones:[st]});
  result.push(...output[0]);
 }
 fs.writeFileSync(__dirname + '/audio-test-'+st+'.json',JSON.stringify(result.slice(-24000)));
}
[-12,-5,0,5,12].forEach(test);
console.log('audio-worklet-rendered-samples-ok');
