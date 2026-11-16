/// <reference types="vite/client" />

// Lets plain `tsc` / typescript-eslint resolve `import X from './X.vue'`.
// vue-tsc analyses the real component types and ignores this shim.
declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<object, object, unknown>;
  export default component;
}
