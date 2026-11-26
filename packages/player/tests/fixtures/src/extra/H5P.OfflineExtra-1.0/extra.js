/**
 * Proof that a dependency named only by the library bundle loads: a content-only export lists its
 * main library alone, so unmerged this never runs ("Unable to find constructor for: H5P.Text").
 */
window.h5pOfflineExtraLoaded = true;
