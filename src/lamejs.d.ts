// Minimal ambient types for @breezystack/lamejs. The package ships its own
// types in some versions, but they are loose; this declares only the surface
// `audio.ts` uses so the encoder call stays type-checked under `strict`.
declare module "@breezystack/lamejs" {
  export class Mp3Encoder {
    constructor(channels: number, sampleRate: number, kbps: number);
    encodeBuffer(left: Int16Array, right?: Int16Array): Int8Array;
    flush(): Int8Array;
  }
}
