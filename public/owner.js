/* Mention du propriétaire : lit la ligne publique « ownership » (remise du Carnet à Camélia Borget) et adapte les pages statiques. */
(function () {
  var URL = 'https://ovkjhtqzbgdlylxhhkjc.supabase.co/rest/v1/platform_settings?select=value&key=eq.ownership&limit=1';
  fetch(URL, { headers: { apikey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im92a2podHF6YmdkbHlseGhoa2pjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA0OTU4MTksImV4cCI6MjEwNjA3MTgxOX0.NQO0H7ZktUqfcot_eW6ApKSHOLaaS2Qc9xajCqeYjA4' } }).then(function (r) { return r.ok ? r.json() : []; }).then(function (rows) {
    var v = rows && rows[0] && rows[0].value; if (!v || !v.active) return;
    var name = String(v.name || 'Camélia Borget').replace(/[<>&"]/g, '');
    document.querySelectorAll('[data-owner-intro]').forEach(function (el) { el.textContent = 'créée par Noah Borget et offerte à ' + name + ', qui en assure la direction'; });
  }).catch(function () {});
})();
