/**
 * Source deployed as a CloudFront Function on the website's default cache
 * behavior. Keep this self-contained: CloudFront Functions do not support
 * imports, and tests execute this exact string rather than a second model of
 * the routing logic.
 */
export const SPA_REWRITE_FUNCTION_CODE = `function trim(value) {
  return value.replace(/^\\s+|\\s+$/g, "");
}

function acceptsHTML(value) {
  var ranges = (value || "").split(",");
  for (var i = 0; i < ranges.length; i++) {
    var parts = ranges[i].split(";");
    if (trim(parts[0]).toLowerCase() !== "text/html") {
      continue;
    }

    var quality = 1;
    var valid = true;
    var sawQuality = false;
    for (var j = 1; j < parts.length; j++) {
      var parameter = trim(parts[j]);
      var separator = parameter.indexOf("=");
      if (!parameter || separator <= 0) {
        valid = false;
        break;
      }

      var name = trim(parameter.substring(0, separator)).toLowerCase();
      var parameterValue = trim(parameter.substring(separator + 1));
      // Deliberately accept only RFC token names and values. Quoted-string
      // support would require delimiter-aware parsing; fail closed instead of
      // partially accepting it at the edge.
      var token = /^[!#$%&'*+.^_\\x60|~0-9A-Za-z-]+$/;
      if (!token.test(name) || !token.test(parameterValue)) {
        valid = false;
        break;
      }

      if (name !== "q") {
        continue;
      }
      if (sawQuality) {
        valid = false;
        break;
      }

      sawQuality = true;
      var qualityText = parameterValue;
      if (!/^(?:0(?:\\.[0-9]{0,3})?|1(?:\\.0{0,3})?)$/.test(qualityText)) {
        valid = false;
        break;
      }
      quality = parseFloat(qualityText);
    }

    if (valid && quality > 0) {
      return true;
    }
  }
  return false;
}

function handler(event) {
  var request = event.request;
  var uri = request.uri || "/";

  // SPA fallback is only for top-level document navigation. In particular,
  // never turn API-style POST/HEAD/OPTIONS requests into successful HTML.
  if (request.method !== "GET") {
    return request;
  }

  // These have ordered Router behaviors and should not normally reach this
  // function. Keep the guard as defense in depth against a future route-order
  // or association change.
  if (
    uri === "/api" ||
    uri.indexOf("/api/") === 0 ||
    uri === "/login" ||
    uri.indexOf("/login/") === 0 ||
    uri === "/logout" ||
    uri.indexOf("/logout/") === 0
  ) {
    return request;
  }

  // Asset namespaces can contain extensionless files. Well-known resources
  // are protocol endpoints, not client-side routes.
  if (
    uri === "/assets" ||
    uri.indexOf("/assets/") === 0 ||
    uri === "/static" ||
    uri.indexOf("/static/") === 0 ||
    uri === "/.well-known" ||
    uri.indexOf("/.well-known/") === 0
  ) {
    return request;
  }

  // Every object in the website bucket sits either at its root or under the
  // asset namespaces excluded above, so a suffixed top-level path is a concrete
  // object and S3 should answer for it. A dot deeper in the path belongs to a
  // route parameter: S3 accepts bucket names such as my.bucket.com, and
  // /buckets/my.bucket.com has to stay a deep link into the console.
  var segments = uri.split("/");
  if (segments.length === 2 && segments[1].indexOf(".") !== -1) {
    return request;
  }

  var headers = request.headers || {};
  var accept = headers.accept ? headers.accept.value : "";
  if (!acceptsHTML(accept)) {
    return request;
  }

  // Modern browsers make navigation intent explicit. Treat missing Fetch
  // Metadata as compatible with older browsers and crawlers, but fail closed
  // when the headers identify a subresource or fetch/XHR request.
  var destination = headers["sec-fetch-dest"] ? headers["sec-fetch-dest"].value : "";
  if (destination && destination.toLowerCase() !== "document") {
    return request;
  }
  var mode = headers["sec-fetch-mode"] ? headers["sec-fetch-mode"].value : "";
  if (mode && mode.toLowerCase() !== "navigate") {
    return request;
  }

  request.uri = "/index.html";
  return request;
}`;
