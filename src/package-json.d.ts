// Lets `cli.ts` import the project's package.json for its version without
// turning on `resolveJsonModule` — which would pull a file from outside
// `rootDir` into the TypeScript program. This ambient declaration types the
// import; Bun and Node resolve the real file at build/runtime.
declare module "*/package.json" {
  const pkg: { version: string };
  export default pkg;
}
