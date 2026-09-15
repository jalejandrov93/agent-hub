// A grandchild process that just stays alive until killed. It does NOT
// install a SIGTERM handler, so the default (terminate) behavior applies.
setInterval(() => {}, 1000)
