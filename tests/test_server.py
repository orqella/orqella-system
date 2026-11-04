from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
import server  # noqa: E402


class EndpointParsingTests(unittest.TestCase):
    def test_linux_endpoints(self) -> None:
        self.assertEqual(server._split_endpoint("1.2.3.4:443"), ("1.2.3.4", 443))
        self.assertEqual(server._split_endpoint("[::1]:8080"), ("::1", 8080))
        self.assertEqual(server._split_endpoint("fe80::1%eth0:68"), ("fe80::1", 68))
        self.assertEqual(server._split_endpoint("*:22"), ("", 22))
        self.assertEqual(server._split_endpoint("0.0.0.0:22"), ("", 22))
        self.assertEqual(server._split_endpoint("invalid"), ("", 0))

    def test_macos_endpoints(self) -> None:
        self.assertEqual(server._split_macos_endpoint("1.2.3.4.443"), ("1.2.3.4", 443))
        self.assertEqual(server._split_macos_endpoint("[::1].443"), ("::1", 443))
        self.assertEqual(server._split_macos_endpoint("fe80::1%en0.68"), ("fe80::1", 68))
        self.assertEqual(server._split_macos_endpoint("*.*"), ("", 0))
        self.assertEqual(server._split_macos_endpoint("-"), ("", 0))


class ParserTests(unittest.TestCase):
    def test_ss_output_folds_info_lines(self) -> None:
        text = """tcp   ESTAB  0  0  127.0.0.1:9477  127.0.0.1:51234  users:((\\\"orqella\\\",pid=42,fd=9))
\t cubic wscale:7,7 rtt:0.1/0.1 ato:40 mss:65483
tcp   LISTEN 0  4096  0.0.0.0:22  0.0.0.0:*
"""
        rows = server._parse_ss(text)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["state"], "ESTAB")
        self.assertEqual(rows[0]["local"], "127.0.0.1:9477")
        self.assertIn("users:", rows[0]["meta"])
        self.assertIn("rtt:0.1", rows[0]["info"])
        self.assertEqual(rows[1]["state"], "LISTEN")

    def test_macos_netstat_output(self) -> None:
        text = """tcp4       0      0  192.168.1.10.51234     93.184.216.34.443      ESTABLISHED 123 456789 0
tcp6       0      0  [::1].8080             [::1].51234            ESTABLISHED 456 456789 0
udp4       0      0  192.168.1.10.5353      *.*                                0 0 0
"""
        rows = server._parse_macos_netstat(text, "tcp")
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["proto"], "tcp")
        self.assertEqual(rows[0]["state"], "ESTAB")
        self.assertEqual(rows[0]["local_ip"], "192.168.1.10")
        self.assertEqual(rows[0]["remote_port"], 443)
        self.assertEqual(rows[0]["pid"], 0)
        self.assertEqual(rows[1]["remote_ip"], "::1")

    def test_loopback_detection(self) -> None:
        for value in ("127.0.0.1", "127.9.8.7", "::1", "localhost", "::ffff:127.0.0.1"):
            self.assertTrue(server.is_loopback(value), value)
        for value in ("192.168.1.1", "8.8.8.8", "::2"):
            self.assertFalse(server.is_loopback(value), value)


if __name__ == "__main__":
    unittest.main()
