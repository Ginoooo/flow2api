if (navigator.locks) {
  navigator.locks.request('flow2api_solver_active', () => new Promise(() => {})).catch(() => {});
}