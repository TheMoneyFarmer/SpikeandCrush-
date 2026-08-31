'use strict';

window.Admin = window.Admin || {};

// Connects to this same admin server's own Socket.io instance (same origin,
// port 3003). The admin server itself polls the game server's internal
// bridge every 5s and re-emits real data here - see admin/server.js.
(function () {
  let socket = null;
  function connect() {
    if (socket) return socket;
    socket = io({ withCredentials: true });
    return socket;
  }
  Admin.socket = connect();
})();
