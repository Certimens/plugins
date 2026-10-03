// What a service worker has and a page does not. @types/chrome needs lib.dom to load, and
// lib.dom and lib.webworker cannot be combined (they redeclare each other), so the worker is
// checked against the DOM library and the handful of globals it really has are declared here.
// Only jsconfig.worker.json reads this file.
declare function importScripts(...urls: string[]): void;
