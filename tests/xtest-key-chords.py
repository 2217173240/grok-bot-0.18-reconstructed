import ctypes
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest


class KeyEvent(ctypes.Structure):
    _fields_ = [
        ("type", ctypes.c_int), ("serial", ctypes.c_ulong), ("send_event", ctypes.c_int),
        ("display", ctypes.c_void_p), ("window", ctypes.c_ulong), ("root", ctypes.c_ulong),
        ("subwindow", ctypes.c_ulong), ("time", ctypes.c_ulong),
        ("x", ctypes.c_int), ("y", ctypes.c_int), ("x_root", ctypes.c_int), ("y_root", ctypes.c_int),
        ("state", ctypes.c_uint), ("keycode", ctypes.c_uint), ("same_screen", ctypes.c_int),
    ]


class Event(ctypes.Union):
    _fields_ = [("key", KeyEvent), ("pad", ctypes.c_long * 24)]


class KeyChordTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.helper = Path(sys.argv[0]).resolve().parents[1] / "docker/bin/xtest-input-local.py"
        read_fd, write_fd = os.pipe()
        cls.server = subprocess.Popen(["Xvfb", "-displayfd", str(write_fd), "-screen", "0", "320x200x24", "-nolisten", "tcp"], pass_fds=(write_fd,), stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        os.close(write_fd)
        with os.fdopen(read_fd) as ready:
            cls.display_name = ":" + ready.readline().strip()
        cls.x11 = ctypes.cdll.LoadLibrary("libX11.so.6")
        for name, result, args in [
            ("XOpenDisplay", ctypes.c_void_p, [ctypes.c_char_p]),
            ("XDefaultRootWindow", ctypes.c_ulong, [ctypes.c_void_p]),
            ("XCreateSimpleWindow", ctypes.c_ulong, [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.c_uint, ctypes.c_uint, ctypes.c_uint, ctypes.c_ulong, ctypes.c_ulong]),
            ("XSelectInput", ctypes.c_int, [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_long]),
            ("XMapWindow", ctypes.c_int, [ctypes.c_void_p, ctypes.c_ulong]),
            ("XSetInputFocus", ctypes.c_int, [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]),
            ("XSync", ctypes.c_int, [ctypes.c_void_p, ctypes.c_int]),
            ("XPending", ctypes.c_int, [ctypes.c_void_p]),
            ("XNextEvent", ctypes.c_int, [ctypes.c_void_p, ctypes.POINTER(Event)]),
            ("XStringToKeysym", ctypes.c_ulong, [ctypes.c_char_p]),
            ("XKeysymToKeycode", ctypes.c_uint, [ctypes.c_void_p, ctypes.c_ulong]),
            ("XQueryKeymap", ctypes.c_int, [ctypes.c_void_p, ctypes.c_char_p]),
            ("XCloseDisplay", ctypes.c_int, [ctypes.c_void_p]),
        ]:
            fn = getattr(cls.x11, name)
            fn.restype, fn.argtypes = result, args
        cls.display = cls.x11.XOpenDisplay(cls.display_name.encode())
        if not cls.display:
            raise RuntimeError("Cannot open isolated Xvfb")
        cls.window = cls.x11.XCreateSimpleWindow(cls.display, cls.x11.XDefaultRootWindow(cls.display), 0, 0, 100, 100, 0, 0, 0)
        cls.x11.XSelectInput(cls.display, cls.window, 15 | 64)
        cls.x11.XMapWindow(cls.display, cls.window)
        cls.x11.XSetInputFocus(cls.display, cls.window, 1, 0)
        cls.x11.XSync(cls.display, False)

    @classmethod
    def tearDownClass(cls):
        cls.x11.XCloseDisplay(cls.display)
        cls.server.terminate()
        cls.server.communicate(timeout=5)

    def events(self):
        self.x11.XSync(self.display, False)
        events = []
        while self.x11.XPending(self.display):
            event = Event()
            self.x11.XNextEvent(self.display, ctypes.byref(event))
            if event.key.type in (2, 3, 4, 5, 6):
                events.append((event.key.type, event.key.keycode, event.key.state))
        return events

    def code(self, name):
        return self.x11.XKeysymToKeycode(self.display, self.x11.XStringToKeysym(name.encode()))

    def assertReleased(self):
        state = ctypes.create_string_buffer(32)
        self.x11.XQueryKeymap(self.display, state)
        self.assertEqual(state.raw, bytes(32))

    def test_standard_chords(self):
        for chord, names, modifier in [
            ("super", ["Super_L"], 0), ("Alt+F2", ["Alt_L", "F2"], 8),
            ("alt+f2", ["Alt_L", "F2"], 8), ("ctrl+a", ["Control_L", "a"], 4),
            ("super+Tab", ["Super_L", "Tab"], 64),
            ("Control+Shift+a", ["Control_L", "Shift_L", "a"], 5),
            ("A", ["Shift_L", "a"], 1), ("Escape", ["Escape"], 0),
        ]:
            with self.subTest(chord=chord):
                self.events()
                result = subprocess.run([sys.executable, str(self.helper), self.display_name], input=json.dumps({"action": "key", "key": chord}), text=True, capture_output=True, timeout=5)
                self.assertEqual(result.returncode, 0, result.stderr)
                events = self.events()
                codes = [self.code(name) for name in names]
                self.assertEqual([(kind, code) for kind, code, _ in events], [(2, code) for code in codes] + [(3, code) for code in reversed(codes)])
                self.assertEqual(events[len(codes) - 1][2] & modifier, modifier)
                self.assertReleased()

    def test_invalid_chord_has_no_events(self):
        for chord in ["ctrl+NoSuchKey", "ctrl++a", "cmd", ""]:
            with self.subTest(chord=chord):
                self.events()
                result = subprocess.run([sys.executable, str(self.helper), self.display_name], input=json.dumps({"action": "key", "key": chord, "x": 50, "y": 50}), text=True, capture_output=True, timeout=5)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(self.events(), [])
                self.assertReleased()


if __name__ == "__main__":
    unittest.main()
