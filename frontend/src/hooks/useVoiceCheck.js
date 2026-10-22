import { useCallback, useEffect, useRef, useState } from 'react'
import { parseSpokenNumber, speak, startAlarm, stopAlarm, tone } from '../lib/speech'

const Recognition = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null

// Runs the spoken alertness check: asks the question aloud, listens for the
// answer, sends it to the server for checking, and sounds the alarm when the
// server says the driver did not answer in time.
export default function useVoiceCheck({ talkback, talkbackEvent, send }) {
  const [transcript, setTranscript] = useState('')
  const [listening, setListening] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const s = useRef({ id: null, rec: null, ignoreUntil: 0, lastSent: null }).current
  const tbRef = useRef(talkback)
  tbRef.current = talkback

  const submit = useCallback(
    (text, method = 'speech') => {
      const tb = tbRef.current
      if (!tb) return false
      const n = parseSpokenNumber(text)
      if (n === null) return false
      if (method === 'speech' && s.lastSent === n) return false
      s.lastSent = n
      send({ type: 'talkback_answer', id: tb.id, answer: n, transcript: text.trim(), method })
      return true
    },
    [s, send],
  )

  const stopListening = useCallback(() => {
    const rec = s.rec
    s.rec = null
    try {
      rec?.abort()
    } catch {
      /* ignore */
    }
    setListening(false)
  }, [s])

  const startListening = useCallback(() => {
    if (!Recognition || s.rec) return
    const rec = new Recognition()
    rec.lang = 'en-IN'
    rec.continuous = true
    rec.interimResults = true
    rec.onresult = (e) => {
      if (Date.now() < s.ignoreUntil) return
      let text = ''
      for (let i = e.resultIndex; i < e.results.length; i++) text += e.results[i][0].transcript
      setTranscript(text.trim())
      submit(text)
    }
    rec.onend = () => {
      if (s.rec !== rec) return
      s.rec = null
      setListening(false)
      if (tbRef.current) setTimeout(startListening, 300) // browsers end sessions on silence
    }
    rec.onerror = () => {}
    try {
      rec.start()
      s.rec = rec
      setListening(true)
    } catch {
      /* already started */
    }
  }, [s, submit])

  const ask = useCallback(
    (prefix = '') => {
      const tb = tbRef.current
      if (!tb) return
      setSpeaking(true)
      s.ignoreUntil = Date.now() + 60_000
      speak(`${prefix}${tb.question}`, {
        onEnd: () => {
          setSpeaking(false)
          s.ignoreUntil = Date.now() + 250
          startListening()
        },
      })
    },
    [s, startListening],
  )

  // New check
  useEffect(() => {
    if (!talkback) {
      stopAlarm()
      stopListening()
      s.id = null
      return
    }
    if (talkback.id !== s.id) {
      s.id = talkback.id
      s.lastSent = null
      setTranscript('')
      tone(880, 0.15, 0.3, 'sine')
      tone(1320, 0.2, 0.3, 'sine', 0.18)
      setTimeout(() => ask('Alertness check. '), 450)
    }
    if (talkback.phase === 'alarm') startAlarm()
    else stopAlarm()
  }, [talkback, ask, stopListening, s])

  // Wrong answer / finished
  useEffect(() => {
    if (!talkbackEvent) return
    if (talkbackEvent.kind === 'retry') {
      s.lastSent = null
      tone(330, 0.25, 0.35, 'sawtooth')
      setTimeout(() => ask('Not quite. '), 350)
    } else if (talkbackEvent.kind === 'done') {
      stopAlarm()
      stopListening()
      if (talkbackEvent.result?.correct) speak('Correct. Stay alert, and take a break at the next safe stop.')
      else if (talkbackEvent.result?.outcome === 'recovered') speak('Alarm stopped. Please pull over and rest when it is safe.')
    }
  }, [talkbackEvent, ask, stopListening, s])

  useEffect(() => () => {
    stopAlarm()
    stopListening()
  }, [stopListening])

  return { transcript, listening, speaking, voiceSupported: !!Recognition, submitTyped: (t) => submit(t, 'typed'), repeat: () => ask() }
}
