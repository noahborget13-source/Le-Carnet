(function () {
  if (window.__LE_CARNET_POSTHOG_LOADING__) return;
  window.__LE_CARNET_POSTHOG_LOADING__ = true;

  fetch('/api/posthog-config', { cache: 'no-store' })
    .then(function (response) { return response.json(); })
    .then(function (config) {
      if (!config.configured) {
        if (config.development) {
          throw new Error(config.missingVariable + ' variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ' + config.missingVariable + ' is configured');
        }
        return;
      }

      var script = document.createElement('script');
      script.async = true;
      script.src = 'https://cdn.jsdelivr.net/npm/posthog-js@1.449.2/dist/array.js';
      script.onload = function () {
        window.posthog.init(config.key, {
          api_host: config.host,
          capture_exceptions: true,
          tracing_headers: [window.location.hostname],
          logs: { serviceName: 'le-carnet-web' }
        });
        window.posthog.logger?.info('posthog client ready');
        window.dispatchEvent(new Event('posthog:ready'));
      };
      document.head.appendChild(script);
    })
    .catch(function (error) {
      if (error && /variable required by PostHog/.test(error.message)) {
        setTimeout(function () { throw error; });
      }
    });
}());
