// Empty runtime module that makes `types-augment.d.ts` a module-scoped
// (rather than global) augmentation. NodeNext requires a value import with a
// `.js` specifier inside a `declare module` block to resolve correctly against
// `../../types.js`. This file emits an empty module and has no runtime effect.
export {};
