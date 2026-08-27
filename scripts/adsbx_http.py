"""Shared request headers for ADS-B Exchange fetches.

Since ~2026-07/08 the globe.adsbexchange.com CDN returns 403 for requests
without a globe Referer (a bare User-Agent is no longer enough). With the
Referer present, semantics are unchanged: existing slots return 200 and
missing/future slots return 404, which callers already handle.
"""

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36"
)

GLOBE_HEADERS = {
    "User-Agent": USER_AGENT,
    "Referer": "https://globe.adsbexchange.com/",
    "Accept": "*/*",
}

DOWNLOAD_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "*/*",
}
