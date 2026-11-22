import Foundation
import CoreGraphics
import ApplicationServices

setbuf(stdout, nil)

let AIRDESK_MAGIC: Int64 = 0x41495244

// Verify macOS Accessibility permission upfront and inform Electron Host if missing
if !AXIsProcessTrusted() {
  print("{\"event\":\"permission_warning\",\"message\":\"macOS 尚未授予辅助功能权限，请在系统设置-隐私与安全性-辅助功能中勾选 AirDesk Host\"}")
  fflush(stdout)
}

var leftDown = false
var rightDown = false
var middleDown = false
var activeModifierFlags: CGEventFlags = []
var activeKeyCodes = Set<CGKeyCode>()

// Background CGEvent tap to detect real physical mouse movement (ignoring our own AIRDESK_MAGIC events)
var lastPhysicalNotifyNs: UInt64 = 0
func startPhysicalMouseTap() {
  DispatchQueue.global(qos: .userInteractive).async {
    let mask = CGEventMask(1 << CGEventType.mouseMoved.rawValue)
    let callback: CGEventTapCallBack = { _, _, event, _ in
      let userData = event.getIntegerValueField(.eventSourceUserData)
      if userData != AIRDESK_MAGIC {
        let now = DispatchTime.now().uptimeNanoseconds
        if now - lastPhysicalNotifyNs > 600_000_000 {
          lastPhysicalNotifyNs = now
          print("{\"event\":\"physical_mouse_override\"}")
          fflush(stdout)
        }
      }
      return Unmanaged.passUnretained(event)
    }
    if let tap = CGEvent.tapCreate(
      tap: .cgSessionEventTap,
      place: .headInsertEventTap,
      options: .listenOnly,
      eventsOfInterest: mask,
      callback: callback,
      userInfo: nil
    ) {
      let src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
      CFRunLoopAddSource(CFRunLoopGetCurrent(), src, .commonModes)
      CGEvent.tapEnable(tap: tap, enable: true)
      CFRunLoopRun()
    }
  }
}

func postTagged(_ event: CGEvent?) {
  guard let e = event else { return }
  e.setIntegerValueField(.eventSourceUserData, value: AIRDESK_MAGIC)
  e.post(tap: .cghidEventTap)
}

func moveEventType() -> (CGEventType, CGMouseButton) {
  if leftDown { return (.leftMouseDragged, .left) }
  if rightDown { return (.rightMouseDragged, .right) }
  if middleDown { return (.otherMouseDragged, .center) }
  return (.mouseMoved, .left)
}

func mapCodeToMacKey(_ code: String) -> (CGKeyCode, CGEventFlags?)? {
  switch code {
  case "KeyA": return (0, nil)
  case "KeyS": return (1, nil)
  case "KeyD": return (2, nil)
  case "KeyF": return (3, nil)
  case "KeyH": return (4, nil)
  case "KeyG": return (5, nil)
  case "KeyZ": return (6, nil)
  case "KeyX": return (7, nil)
  case "KeyC": return (8, nil)
  case "KeyV": return (9, nil)
  case "KeyB": return (11, nil)
  case "KeyQ": return (12, nil)
  case "KeyW": return (13, nil)
  case "KeyE": return (14, nil)
  case "KeyR": return (15, nil)
  case "KeyY": return (16, nil)
  case "KeyT": return (17, nil)
  case "Digit1": return (18, nil)
  case "Digit2": return (19, nil)
  case "Digit3": return (20, nil)
  case "Digit4": return (21, nil)
  case "Digit6": return (22, nil)
  case "Digit5": return (23, nil)
  case "Equal": return (24, nil)
  case "Digit9": return (25, nil)
  case "Digit7": return (26, nil)
  case "Minus": return (27, nil)
  case "Digit8": return (28, nil)
  case "Digit0": return (29, nil)
  case "BracketRight": return (30, nil)
  case "KeyO": return (31, nil)
  case "KeyU": return (32, nil)
  case "BracketLeft": return (33, nil)
  case "KeyI": return (34, nil)
  case "KeyP": return (35, nil)
  case "Enter", "NumpadEnter": return (36, nil)
  case "KeyL": return (37, nil)
  case "KeyJ": return (38, nil)
  case "Quote": return (39, nil)
  case "KeyK": return (40, nil)
  case "Semicolon": return (41, nil)
  case "Backslash": return (42, nil)
  case "Comma": return (43, nil)
  case "Slash": return (44, nil)
  case "KeyN": return (45, nil)
  case "KeyM": return (46, nil)
  case "Period": return (47, nil)
  case "Tab": return (48, nil)
  case "Space": return (49, nil)
  case "Backquote": return (50, nil)
  case "Backspace": return (51, nil)
  case "Escape": return (53, nil)
  case "CapsLock": return (57, nil)
  case "MetaLeft", "MetaRight": return (55, .maskCommand)
  case "ShiftLeft", "ShiftRight": return (56, .maskShift)
  case "AltLeft", "AltRight": return (58, .maskAlternate)
  case "ControlLeft", "ControlRight": return (59, .maskControl)
  case "Insert": return (114, nil)
  case "PrintScreen": return (105, nil)
  case "Delete": return (117, nil)
  case "Home": return (115, nil)
  case "End": return (119, nil)
  case "PageUp": return (116, nil)
  case "PageDown": return (121, nil)
  case "ArrowLeft": return (123, nil)
  case "ArrowRight": return (124, nil)
  case "ArrowDown": return (125, nil)
  case "ArrowUp": return (126, nil)
  case "Numpad0": return (82, nil)
  case "Numpad1": return (83, nil)
  case "Numpad2": return (84, nil)
  case "Numpad3": return (85, nil)
  case "Numpad4": return (86, nil)
  case "Numpad5": return (87, nil)
  case "Numpad6": return (88, nil)
  case "Numpad7": return (89, nil)
  case "Numpad8": return (91, nil)
  case "Numpad9": return (92, nil)
  case "NumpadDecimal": return (65, nil)
  case "NumpadMultiply": return (67, nil)
  case "NumpadAdd": return (69, nil)
  case "NumpadDivide": return (75, nil)
  case "NumpadSubtract": return (78, nil)
  case "F1": return (122, nil)
  case "F2": return (120, nil)
  case "F3": return (99, nil)
  case "F4": return (118, nil)
  case "F5": return (96, nil)
  case "F6": return (97, nil)
  case "F7": return (98, nil)
  case "F8": return (100, nil)
  case "F9": return (101, nil)
  case "F10": return (109, nil)
  case "F11": return (103, nil)
  case "F12": return (111, nil)
  default: return nil
  }
}

startPhysicalMouseTap()

while let line = readLine(strippingNewline: true) {
  guard let data = line.data(using: .utf8),
        let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let t = obj["t"] as? String else { continue }

  let currentPos = CGEvent(source: nil)?.location ?? CGPoint(x: 0, y: 0)

  switch t {
  case "m:rel":
    let dx = obj["dx"] as? Double ?? 0
    let dy = obj["dy"] as? Double ?? 0
    let next = CGPoint(x: currentPos.x + dx, y: currentPos.y + dy)
    let (evtType, btn) = moveEventType()
    postTagged(CGEvent(mouseEventSource: nil, mouseType: evtType, mouseCursorPosition: next, mouseButton: btn))

  case "m:abs":
    // Main process sends exact macOS logical point coordinates (px/py in DIP, NOT scaled by Retina 2x)
    if let px = obj["px"] as? Double, let py = obj["py"] as? Double {
      let next = CGPoint(x: px, y: py)
      let (evtType, btn) = moveEventType()
      postTagged(CGEvent(mouseEventSource: nil, mouseType: evtType, mouseCursorPosition: next, mouseButton: btn))
    }

  case "m:btn":
    let btn = obj["button"] as? String ?? "left"
    let down = (obj["state"] as? String ?? "up") == "down"
    let type: CGEventType
    let cgBtn: CGMouseButton
    if btn == "right" {
      rightDown = down
      type = down ? .rightMouseDown : .rightMouseUp
      cgBtn = .right
    } else if btn == "middle" {
      middleDown = down
      type = down ? .otherMouseDown : .otherMouseUp
      cgBtn = .center
    } else {
      leftDown = down
      type = down ? .leftMouseDown : .leftMouseUp
      cgBtn = .left
    }
    postTagged(CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: currentPos, mouseButton: cgBtn))

  case "m:whl":
    let dy = Int32(-(obj["dy"] as? Double ?? 0) * 4)
    let dx = Int32((obj["dx"] as? Double ?? 0) * 4)
    postTagged(CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0))

  case "k:down", "k:up":
    let down = t == "k:down"
    if let code = obj["code"] as? String, let (vk, modFlag) = mapCodeToMacKey(code) {
      if let flag = modFlag {
        if down { activeModifierFlags.insert(flag) } else { activeModifierFlags.remove(flag) }
      }
      if down { activeKeyCodes.insert(vk) } else { activeKeyCodes.remove(vk) }
      if let evt = CGEvent(keyboardEventSource: nil, virtualKey: vk, keyDown: down) {
        evt.flags = activeModifierFlags
        postTagged(evt)
      }
    }

  case "k:release_all":
    for vk in activeKeyCodes {
      postTagged(CGEvent(keyboardEventSource: nil, virtualKey: vk, keyDown: false))
    }
    activeKeyCodes.removeAll()
    activeModifierFlags = []
    if leftDown {
      leftDown = false
      postTagged(CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: currentPos, mouseButton: .left))
    }
    if rightDown {
      rightDown = false
      postTagged(CGEvent(mouseEventSource: nil, mouseType: .rightMouseUp, mouseCursorPosition: currentPos, mouseButton: .right))
    }
    if middleDown {
      middleDown = false
      postTagged(CGEvent(mouseEventSource: nil, mouseType: .otherMouseUp, mouseCursorPosition: currentPos, mouseButton: .center))
    }

  case "text:unicode":
    if let text = obj["text"] as? String {
      let utf16 = Array(text.utf16)
      if let downEvt = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
         let upEvt = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) {
        downEvt.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
        upEvt.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
        postTagged(downEvt)
        postTagged(upEvt)
      }
    }

  default:
    break
  }
}
