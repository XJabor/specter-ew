"""Process-wide pacing and 429 retry for the public elevation API.

Scenario loads fire the J/S, ring, footprint and EP calculations at once;
before v1.2.0 each thread called the API immediately and most were refused
(HTTP 429), falling back to flat circles. These tests pin that concurrent
callers are serialized behind one pacing clock and that rate-limited
requests are retried. requests.post is faked; no network access occurs.
"""

import contextlib
import threading
import time
import unittest
from unittest.mock import patch

import requests

import core.elevation as elevation

DELAY = 0.05  # shrunk rate-limit interval so the tests run fast


class _Resp:
    def __init__(self, status, n=0, retry_after=None):
        self.status_code = status
        self.headers = {'Retry-After': retry_after} if retry_after is not None else {}
        self._n = n

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f'{self.status_code} error', response=self)

    def json(self):
        return {'status': 'OK', 'results': [{'elevation': 10.0}] * self._n}


def _locations(n, lon=-117.0):
    return [{'latitude': 35.0 + i * 1e-3, 'longitude': lon} for i in range(n)]


class RateLimitTests(unittest.TestCase):
    def setUp(self):
        patches = [
            patch.object(elevation, '_RATE_LIMIT_DELAY', DELAY),
            patch.object(elevation, '_MAX_BACKOFF_S', 0.2),
            patch.object(elevation, '_last_api_request', float('-inf')),
            patch.object(elevation, '_point_cache', {}),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.calls = []            # (start, end) monotonic times per POST
        self.in_flight = 0
        self.max_in_flight = 0
        self.guard = threading.Lock()

    def _fake_post(self, statuses=None):
        statuses = list(statuses or [])

        def post(url, json, timeout):
            n = len(json['locations'].split('|'))
            with self.guard:
                self.in_flight += 1
                self.max_in_flight = max(self.max_in_flight, self.in_flight)
                status = statuses.pop(0) if statuses else 200
            start = time.monotonic()
            time.sleep(0.01)  # simulated network latency
            with self.guard:
                self.in_flight -= 1
                self.calls.append((start, time.monotonic()))
            return _Resp(status, n, retry_after='0.1' if status == 429 else None)
        return post

    def test_concurrent_callers_are_serialized_and_paced(self):
        with patch.object(elevation.requests, 'post', self._fake_post()):
            results = [None] * 6
            # Distinct coordinates per caller, so every call needs the API.
            threads = [threading.Thread(target=lambda i=i: results.__setitem__(
                i, elevation._fetch_online(_locations(3, lon=-117.0 - i)))) for i in range(6)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
        self.assertTrue(all(r == [10.0] * 3 for r in results))
        self.assertEqual(self.max_in_flight, 1, 'requests must never overlap')
        starts = sorted(s for s, _ in self.calls)
        gaps = [b - a for a, b in zip(starts, starts[1:])]
        self.assertTrue(all(g >= DELAY - 0.005 for g in gaps), f'gaps too short: {gaps}')

    def test_chunks_of_one_call_are_paced(self):
        with patch.object(elevation.requests, 'post', self._fake_post()):
            out = elevation._fetch_online(_locations(elevation._BATCH_SIZE * 2 + 5))
        self.assertEqual(len(out), elevation._BATCH_SIZE * 2 + 5)
        self.assertEqual(len(self.calls), 3)
        starts = [s for s, _ in self.calls]
        self.assertGreaterEqual(starts[2] - starts[1], DELAY - 0.005)

    def test_429_is_retried_after_retry_after(self):
        with patch.object(elevation.requests, 'post', self._fake_post([429, 200])):
            out = elevation._fetch_online(_locations(4))
        self.assertEqual(out, [10.0] * 4)
        self.assertEqual(len(self.calls), 2)
        self.assertGreaterEqual(self.calls[1][0] - self.calls[0][0], 0.1 - 0.005)

    def test_persistent_429_raises_after_retries(self):
        statuses = [429] * (elevation._MAX_RETRIES + 1)
        with patch.object(elevation.requests, 'post', self._fake_post(statuses)):
            with self.assertRaises(requests.HTTPError):
                elevation._fetch_online(_locations(2))
        self.assertEqual(len(self.calls), elevation._MAX_RETRIES + 1)

    def test_other_http_errors_are_not_retried(self):
        with patch.object(elevation.requests, 'post', self._fake_post([500])):
            with self.assertRaises(requests.HTTPError):
                elevation._fetch_online(_locations(2))
        self.assertEqual(len(self.calls), 1)

    def test_concurrent_identical_requests_share_one_api_call(self):
        # Callers that queued behind an identical request re-check the point
        # cache after acquiring the slot instead of repeating the fetch.
        with patch.object(elevation.requests, 'post', self._fake_post()):
            results = [None] * 6
            threads = [threading.Thread(target=lambda i=i: results.__setitem__(
                i, elevation._fetch_online(_locations(5)))) for i in range(6)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
        self.assertTrue(all(r == [10.0] * 5 for r in results))
        self.assertEqual(len(self.calls), 1)

    def test_partially_cached_request_fetches_only_missing_points(self):
        with patch.object(elevation.requests, 'post', self._fake_post()) as _:
            elevation._fetch_online(_locations(3))
            seen = []
            real = elevation.requests.post
            def spy(url, json, timeout):
                seen.append(len(json['locations'].split('|')))
                return real(url, json=json, timeout=timeout)
            with patch.object(elevation.requests, 'post', spy):
                out = elevation._fetch_online(_locations(5))
        self.assertEqual(out, [10.0] * 5)
        self.assertEqual(seen, [2])

    def test_cache_eviction_after_release_cannot_drop_results(self):
        # Another thread may clear the cache the instant this request releases
        # the API slot. Simulate exactly that: the result must already be
        # complete, not read back from the (now empty) cache.
        real_slot = elevation._api_slot

        @contextlib.contextmanager
        def slot_then_evict():
            with real_slot():
                yield
            elevation._point_cache.clear()

        with patch.object(elevation, '_api_slot', slot_then_evict), \
             patch.object(elevation.requests, 'post', self._fake_post()):
            out = elevation._fetch_online(_locations(4))
        self.assertEqual(out, [10.0] * 4)

    def test_capacity_clear_keeps_points_already_cached_for_this_request(self):
        # A point cached by another thread between this request's first cache
        # read and its slot must survive this request's own capacity clear.
        with patch.object(elevation, '_POINT_CACHE_MAX', 0), \
             patch.object(elevation.requests, 'post', self._fake_post()):
            locs = _locations(3, lon=-105.0)
            real_slot = elevation._api_slot

            @contextlib.contextmanager
            def slot_after_other_thread_cached():
                elevation._point_cache[elevation._point_key(locs[0])] = 10.0
                with real_slot():
                    yield

            with patch.object(elevation, '_api_slot', slot_after_other_thread_cached):
                out = elevation._fetch_online(locs)
        self.assertEqual(out, [10.0] * 3)

    def test_queue_wait_is_bounded(self):
        with patch.object(elevation, '_QUEUE_TIMEOUT_S', 0.05):
            elevation._API_LOCK.acquire()
            try:
                with self.assertRaises(requests.RequestException):
                    elevation._fetch_online(_locations(2, lon=-100.0))
            finally:
                elevation._API_LOCK.release()

    def test_retry_after_parsing(self):
        self.assertEqual(elevation._retry_after_seconds(_Resp(429, retry_after='0.15'), 0), 0.15)
        self.assertEqual(elevation._retry_after_seconds(_Resp(429, retry_after='999'), 0), 0.2)   # capped
        self.assertEqual(elevation._retry_after_seconds(_Resp(429), 1), 2 * DELAY)                 # backoff
        self.assertEqual(elevation._retry_after_seconds(_Resp(429, retry_after='Wed, 21 Oct'), 0), DELAY)


if __name__ == '__main__':
    unittest.main()
