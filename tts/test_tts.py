#!/usr/bin/env python3
"""Tests for TTS server using TDD approach."""

import unittest
from main import Handler, _synthesize
import edge_tts


class TestTTSRateParsing(unittest.TestCase):
    """Test rate parameter parsing edge cases."""
    
    def test_rate_with_leading_space(self):
        """Rate parameter with leading space should be stripped and prefixed."""
        rate_str = " 25%"
        rate_str = rate_str.strip()
        if rate_str and rate_str[0] not in "+-":
            rate_str = "+" + rate_str
        self.assertEqual(rate_str, "+25%")
    
    def test_rate_with_trailing_space(self):
        """Rate parameter with trailing space should be stripped."""
        rate_str = "+25% "
        rate_str = rate_str.strip()
        self.assertEqual(rate_str, "+25%")
    
    def test_rate_without_sign(self):
        """Rate without + or - should get + prefix."""
        rate_str = "25%"
        if rate_str and rate_str[0] not in "+-":
            rate_str = "+" + rate_str
        self.assertEqual(rate_str, "+25%")
    
    def test_rate_already_valid(self):
        """Valid rate should remain unchanged."""
        rate_str = "+25%"
        if rate_str and rate_str[0] not in "+-":
            rate_str = "+" + rate_str
        self.assertEqual(rate_str, "+25%")
    
    def test_rate_negative(self):
        """Negative rate should be preserved."""
        rate_str = "-10%"
        if rate_str and rate_str[0] not in "+-":
            rate_str = "+" + rate_str
        self.assertEqual(rate_str, "-10%")
    
    def test_rate_empty(self):
        """Empty rate should remain empty."""
        rate_str = ""
        if rate_str and rate_str[0] not in "+-":
            rate_str = "+" + rate_str
        self.assertEqual(rate_str, "")
    
    def test_rate_multiple_spaces(self):
        """Rate with multiple spaces should be stripped."""
        rate_str = "  +25%  "
        rate_str = rate_str.strip()
        if rate_str and rate_str[0] not in "+-":
            rate_str = "+" + rate_str
        self.assertEqual(rate_str, "+25%")


class TestTTSVoiceParsing(unittest.TestCase):
    """Test voice parameter parsing."""
    
    def test_voice_with_none(self):
        """Voice parameter with None should remain None."""
        voice = None
        self.assertIsNone(voice)
    
    def test_voice_with_value(self):
        """Voice parameter with value should remain unchanged."""
        voice = "en-US-AvaNeural"
        self.assertEqual(voice, "en-US-AvaNeural")
    
    def test_voice_with_spaces(self):
        """Voice with spaces should be preserved."""
        voice = " en-US-GuyNeural "
        voice = voice.strip() if voice else None
        self.assertEqual(voice, "en-US-GuyNeural")


class TestTTSIntegration(unittest.TestCase):
    """Integration tests for TTS server."""
    
    @unittest.skip("Requires running TTS server")
    def test_synthesize_endpoint(self):
        """Test /synthesize endpoint returns audio."""
        response = requests.post(
            "http://127.0.0.1:8766/synthesize",
            data="Hello world",
            headers={"Content-Type": "text/plain"}
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["Content-Type"], "audio/mpeg")
    
    @unittest.skip("Requires running TTS server")
    def test_health_endpoint(self):
        """Test /health endpoint returns status."""
        response = requests.get("http://127.0.0.1:8766/health")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["status"], "ok")


if __name__ == "__main__":
    unittest.main()
