export default {
  fetch(request, env) {
    return env.SAVIA_REPAIR.fetch(request);
  },
};
