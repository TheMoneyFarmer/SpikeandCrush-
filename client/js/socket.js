'use strict';

window.TW = window.TW || {};

(function () {
  TW.socket = null;

  // Reuses any existing socket by default - a page can safely call this
  // multiple times (e.g. nav.js's notification bell and the page's own game
  // logic both call it) without racing each other. A second, still-connecting
  // caller used to disconnect-and-recreate the first caller's in-flight
  // socket here, silently orphaning whichever listeners were attached first.
  // Pass forceNew explicitly (not currently used anywhere) to really force a
  // fresh connection, e.g. after a token change without a full page reload.
  TW.connectSocket = function connectSocket(forceNew) {
    if (TW.socket && !forceNew) return TW.socket;
    const token = TW.getToken();
    if (!token) return null;
    if (TW.socket) TW.socket.disconnect();
    TW.socket = io({ auth: { token } });
    return TW.socket;
  };

  // Wraps a socket.emit(event, data, ack) call in a Promise so callers can
  // await the server's validation result instead of juggling callbacks.
  TW.emitAck = function emitAck(event, data) {
    return new Promise((resolve) => {
      if (!TW.socket || !TW.socket.connected) {
        resolve({ success: false, error: 'Not connected to server' });
        return;
      }
      TW.socket.emit(event, data, (result) => resolve(result || { success: false, error: 'No response from server' }));
    });
  };
})();
