/*! h5p-offline-player resizer. MIT. Sizes an <iframe> of the H5P embed page to its content. */
/**
 * The page-side half of H5P's resizer protocol: it applies the height a framed page reports. Served
 * from the player's origin, so nothing goes to a third party; a classic script, to run anywhere.
 */
(function () {
  if (window.__h5pResizer) return;
  window.__h5pResizer = true;

  var frameOf = function (source) {
    var frames = document.getElementsByTagName('iframe');
    for (var i = 0; i < frames.length; i++) {
      if (frames[i].contentWindow === source) return frames[i];
    }
    return null;
  };

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.context !== 'h5p' || !event.source) return;
    var frame = frameOf(event.source);
    if (!frame) return;
    switch (data.action) {
      case 'hello':
        // The frame asks whether anyone is listening; the reply makes it start reporting.
        event.source.postMessage({ context: 'h5p', action: 'hello' }, event.origin);
        break;
      case 'prepareResize':
        // The frame is about to measure itself; it wants the box no larger than its content.
        if (typeof data.scrollHeight === 'number' && frame.clientHeight !== data.scrollHeight) {
          frame.style.height = data.scrollHeight + 'px';
        }
        event.source.postMessage({ context: 'h5p', action: 'resizePrepared' }, event.origin);
        break;
      case 'resize':
        if (typeof data.scrollHeight === 'number') frame.style.height = data.scrollHeight + 'px';
        break;
    }
  });

  // A frame that loaded before this script said its hello to nobody; tell every frame the
  // listener is here, and the ones that speak the protocol say hello again.
  var announce = function () {
    var frames = document.getElementsByTagName('iframe');
    for (var i = 0; i < frames.length; i++) {
      try { frames[i].contentWindow.postMessage({ context: 'h5p', action: 'ready' }, '*'); } catch (e) { /* not ours */ }
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', announce);
  else announce();
})();
