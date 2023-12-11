class Piano {
	constructor(canvasId, octaves, ticksPerBeat, model, historyController) {
		if (octaves < 1 || octaves > 7) {
			throw new RangeError("The number of octaves must be between 1 and 7");
		}
		this.bufferBeats = 6;
		this.bufferTicks = Tone.Time(`0:${this.bufferBeats}`).toTicks();
		this.historyWindowBeats = 42;
		this.defaultBPM = 80;
		
		this.octaves = octaves;
		this.ticksPerBeat = ticksPerBeat;
		this.pianoKeys = PianoKey.createPianoKeys(this.octaves);
		this.keyMapShift = 9;
		this.keyMap = PianoKeyMap.getKeyMap(this.keyMapShift, this.pianoKeys.length);
		this.pianoCanvas = new PianoCanvas(this, canvasId);
		this.pianoAudio = new PianoAudio(this.defaultBPM, this.pianoKeys)
		this.model = model;
		this.historyController = historyController;
		
		this.lastActivity = new Date();
		this.modelStartTime = null;
		this.currHistory = null;
		this.sharedHistory = null;
		this.activeNotes = [];
		this.noteQueue = [];
		this.noteBuffer = [];
		
		// Sync `this.contextDateTime` with AudioContext time on a regular interval
		setInterval(() => this.updateContextDateTime(), 1000);
	}
	
	beatsToSeconds(beats) {
		return (beats / this.pianoAudio.bpm) * 60;
	}
	
	getInterval() {
		// Returns the time (in seconds) for the smallest tick interval
		return this.beatsToSeconds(1 / this.ticksPerBeat);
	}
	
	roundToOffset(time) {
		// Rounds up `time` to the nearest interval that is offset by half a timestep
		// Primarily used for calculating callModelEnd time
		const interval = this.beatsToSeconds(1 / this.ticksPerBeat);
		const remainder = (time + (interval / 2)) % interval;
		return time - remainder + interval;
	}
	
	keyPressed(keyNum) {
		if (this.pianoAudio.startTone()) {
			this.seedInputListener();
		}
		this.playNote(new Note(this.pianoKeys[keyNum], 0.8, -1, Tone.Transport.seconds, Actor.Player));
		this.lastActivity = new Date();
	}
	
	keyDown(event) {
		if (event.repeat) return;
		if (event.altKey || event.ctrlKey || event.shiftKey) return;
		if (event.target.classList.contains('historyTitle')) return;
		
		this.lastActivity = new Date();
		switch (event.key) {
			case ' ':
				this.resetAll();
				break;
			case 'ArrowLeft':
			case 'Backspace':
				this.rewind();
				break;
			case 'ArrowUp':
				this.shiftKeyMap(true);
				break;
			case 'ArrowDown':
				this.shiftKeyMap(false);
				break;
			default:
				const keyNum = this.keyMap[event.key.toLowerCase()];
				if (keyNum !== undefined) {
					this.keyPressed(keyNum);
				}
		}
	}
	
	keyUp(event) {
		this.lastActivity = new Date();
		const keyNum = this.keyMap[event.key.toLowerCase()];
		if (keyNum !== undefined) {
			this.releaseNote(this.pianoKeys[keyNum]);
		}
	}
	
	playNote(note, contextTime=Tone.getContext().currentTime) {
		// Check if pianoKey is already active, i.e. note is played again while currently held down, and if so release it
		this.releaseNote(note.key, note.time);
		if (note.duration === -1) {
			// Note is being held down
			this.pianoAudio.sampler.triggerAttack(note.key.keyName, contextTime, note.velocity);
		} else {
			const triggerDuration = note.duration + 0.15; // Add a short delay to the end of the sound (in seconds)
			this.pianoAudio.sampler.triggerAttackRelease(note.key.keyName, triggerDuration, contextTime, note.velocity);
		}
		
		// Keep track of note in `activeNotes` and `noteHistory`
		this.activeNotes.push(note);
		this.currHistory.add(note);
		
		// Draw note on canvases
		const startTime = new Date(this.contextDateTime);
		startTime.setMilliseconds(startTime.getMilliseconds() + (contextTime * 1000));
		this.pianoCanvas.triggerDraw();
		this.notesCanvas.addNoteBar(note.key, startTime, note.duration, this.pianoAudio.bpm, note.actor, note.isRewind);
		
		// Remove note from noteQueue if exists
		const noteIndex = this.noteQueue.indexOf(note);
		if (noteIndex > -1) this.noteQueue.splice(noteIndex, 1);
	}
	
	releaseNote(pianoKey, triggerTime=Tone.Transport.seconds) {
		// Check if `pianoKey` is in the `activeNotes` array, and if so release the note
		const activeNote = this.activeNotes.find(note => note.key === pianoKey);
		if (activeNote !== undefined) {
			this.activeNotes.splice(this.activeNotes.indexOf(activeNote), 1);
			
			// If note is scheduled to be released imminently, don't need to release it manually
			const finalDuration = triggerTime - activeNote.time;
			if (Math.abs(activeNote.duration - finalDuration) > 0.001) {
				this.pianoAudio.sampler.triggerRelease(pianoKey.keyName, Tone.now() + 0.1);
				
				// Update activeNote's final duration, which is also recorded in `noteHistory`
				activeNote.duration = finalDuration;
				this.notesCanvas.releaseNote(pianoKey.keyNum, finalDuration);
			}
		}
	}
	
	releaseAllNotes() {
		const activeNotes = [...this.activeNotes];
		for (const note of activeNotes) {
			this.releaseNote(note.key);
		}
	}
	
	scheduleNote(note) {
		note.scheduleId = Tone.Transport.scheduleOnce((contextTime) => this.playNote(note, contextTime), note.time);
		this.noteQueue.push(note);
	}
	
	async callModel(scheduleImmediately=true) {
		const initiatedTime = new Date();
		
		// Start the window at an offset (i.e. half an interval) earlier so that notes are centered
		const start = Math.max(this.callModelEnd - this.beatsToSeconds(this.historyWindowBeats), -this.getInterval() / 2);
		const history = History.getRecentHistory(this.currHistory.noteHistory, start);
		const queued = History.getRecentHistory(this.noteQueue, start);
		history.push(...queued);
		
		const numRepeats = 3;
		const selectionIdx = 1;
		const generated = await this.model.generateNotes(history, start, this.callModelEnd, this.getInterval(), this.bufferBeats * this.ticksPerBeat, numRepeats, selectionIdx);
		
		// Before scheduling notes, check that the model hasn't been restarted while this function was awaiting a response
		if (this.modelStartTime !== null && initiatedTime >= this.modelStartTime) {
			for (const gen of generated) {
				const note = new Note(this.pianoKeys[gen.keyNum], gen.velocity, gen.duration, gen.time, Actor.Model);
				if (scheduleImmediately) {
					this.scheduleNote(note);
				} else {
					this.noteBuffer.push(note);
				}
			}
			this.callModelEnd += this.beatsToSeconds(this.bufferBeats);
		}
	}
	
	checkActivity() {
		const timeout = 5 * 60 * 1000; // in milliseconds
		if (new Date() - this.lastActivity > timeout) {
			console.log('No user activity, stopping model...');
			this.resetAll();
		}
	}
	
	startModel(glowDelayMs) {
		this.modelStartTime = new Date();
		this.callModel(); // Call model immediately, since setInterval first triggers function after the delay
		
		
		if (this.callModelIntervalId) clearInterval(this.callModelIntervalId);
		if (this.checkActivityIntervalId) clearInterval(this.checkActivityIntervalId);
		this.callModelIntervalId = setInterval(() => this.callModel(), this.beatsToSeconds(this.bufferBeats) * 1000);
		this.checkActivityIntervalId = setInterval(() => this.checkActivity(), 5000);
		this.notesCanvas.startGlow(glowDelayMs);
	}
	
	scheduleStartModel(lastNoteTime) {
		// Schedule startModel to trigger one buffer period before the last note
		this.callModelEnd = this.roundToOffset(lastNoteTime);
		const startGlowDelay = this.beatsToSeconds(this.bufferBeats) * 1000;
		Tone.Transport.scheduleOnce(() => this.startModel(startGlowDelay), Math.max(0, this.callModelEnd - this.beatsToSeconds(this.bufferBeats)));
	}
	
	stopModel() {
		this.notesCanvas.endGlow();
		for (const note of this.noteQueue) {
			Tone.Transport.clear(note.scheduleId);
		}
		this.noteQueue = [];
		this.noteBuffer = [];
		this.modelStartTime = null;
		
		if (typeof this.callModelIntervalId !== 'undefined') {
			clearInterval(this.callModelIntervalId);
		}
		if (typeof this.checkActivityIntervalId !== 'undefined') {
			clearInterval(this.checkActivityIntervalId);
		}
	}
	
	resetAll() {
		this.releaseAllNotes();
		this.stopModel();
		Tone.Transport.cancel();
		Tone.Transport.stop();
		
		this.historyController.addToHistoryList(this.currHistory, this);
		this.currHistory = null;
		this.activeNotes = [];
		this.pianoAudio.toneStarted = false;
		NProgress.done();
		
		if (typeof this.listenerIntervalId !== 'undefined') {
			clearInterval(this.listenerIntervalId);
			document.getElementById("listener").style.visibility = "hidden";
		}
	}
	
	seedInputListener() {
		this.pianoAudio.setBPM(this.defaultBPM);
		this.currHistory = new History(this.pianoAudio.bpm, "Player prompt");
		
		// Start listener progress bar
		NProgress.configure({ minimum: 0.15, trickle: false });
		NProgress.start();
		
		// Start up the awaiter
		this.awaitingInput = true;
		this.listenerIntervalId = setInterval(this.seedInputAwaiter.bind(this), 50);
	}
	
	seedInputAwaiter() {
		const currTime = new Date();
		const inputWaitTime = 1500; // Number of milliseconds to wait for end of player input before starting model
		
		// Display the listening visual indicator if model is connected
		const listenerElement = document.getElementById("listener");
		if (this.model.isConnected) listenerElement.style.visibility = 'visible';
		
		if (this.modelStartTime === null) {
			if (currTime - this.lastActivity >= inputWaitTime && this.activeNotes.length === 0) {
				// Start the model:
				// Detect tempo from user input
				this.pianoAudio.bpm = PianoAudio.detectBpm(this.currHistory.noteHistory, 52, 100);
				this.currHistory.bpm = this.pianoAudio.bpm;
				
				// To determine end time of the seed passage, round up the last note's time to an interval boundary
				this.currHistory.lastSeedNoteTime = this.currHistory.noteHistory.at(-1).time;
				this.callModelEnd = this.roundToOffset(this.currHistory.lastSeedNoteTime);
				this.modelStartTime = currTime;
				this.callModel(false);
				NProgress.inc(0.15);
			}
		} else {
			if (currTime - this.lastActivity < inputWaitTime) {
				// Model was started but new input has been received, reset model and notes queue
				this.stopModel();
				NProgress.set(0.15);
			} else if (currTime - this.lastActivity >= inputWaitTime * 3) {
				// Rewind the transport schedule to the last of the seed input so that the history fed to the model is seamless
				// Subtract buffer seconds since callModel() adds it to callModelEnd
				Tone.Transport.seconds = this.callModelEnd - this.beatsToSeconds(this.bufferBeats);
				Array.from(this.noteBuffer, (note) => this.scheduleNote(note));
				this.noteBuffer = [];
				this.startModel(0);
				
				// Hide the listening visual indicator and stop awaiter
				this.awaitingInput = false;
				listenerElement.style.visibility = "hidden";
				clearInterval(this.listenerIntervalId);
				NProgress.done();
			} else {
				NProgress.inc(0.015);
			}
		}
	}
	
	playExample(data, bpm, title) {
		this.resetAll();
		this.pianoAudio.setBPM(bpm);
		this.pianoAudio.startTone();
		this.lastActivity = new Date();
		this.currHistory = new History(this.pianoAudio.bpm, title);
		
		const start = Tone.Transport.seconds;
		const notes = PianolaModel.queryStringToNotes(data, start, this.getInterval());
		for (const note of notes) {
			this.scheduleNote(new Note(this.pianoKeys[note.keyNum], note.velocity, note.duration, note.time, Actor.Bot));
		}
		this.currHistory.lastSeedNoteTime = notes.at(-1).time;
		this.scheduleStartModel(this.currHistory.lastSeedNoteTime);
	}
	
	rewind() {
		if (!this.pianoAudio.toneStarted || this.awaitingInput) return false;
		
		// Copy queued notes before they are cleared; queue may be needed for replaying notes when rewinding
		const queuedNotes = [...this.noteQueue];
		
		this.historyController.addToHistoryList(this.currHistory, this);
		this.stopModel();
		this.activeNotes = [];
		this.currHistory = this.currHistory.copy();
		
		const secondsToRewind = 8;
		const secondsToReplay = 4; // Number of seconds of history to replay before generating new notes; also acts as buffer
		const replayTimesteps = Math.ceil(this.ticksPerBeat * secondsToReplay * this.pianoAudio.bpm / 60); // Number of timesteps to replay, based on ideal `secondsToReplay`
		const replaySeconds = this.beatsToSeconds(replayTimesteps / this.ticksPerBeat);
		
		// Rewind the transport but no further back than the last seed note
		const newTransportSeconds = this.roundToOffset(Math.max(Tone.Transport.seconds - secondsToRewind, this.currHistory.lastSeedNoteTime - replaySeconds));
		Tone.Transport.seconds = newTransportSeconds;
		this.callModelEnd = newTransportSeconds + replaySeconds;
		
		// When "rewinding" to a future point in time, i.e. last seed note, queued notes prior to new point need to be commited to history
		for (const note of queuedNotes) {
			if (note.time <= this.callModelEnd) this.currHistory.add(note);
		}
		
		// Get future notes within replay window
		const replayNotes = History.removeHistory(History.getRecentHistory(this.currHistory.noteHistory, newTransportSeconds), this.callModelEnd);
		this.currHistory.noteHistory = History.removeHistory(this.currHistory.noteHistory, newTransportSeconds);
		
		for (const note of replayNotes) {
			const newNote = new Note(note.key, note.velocity, note.duration, note.time, note.actor, null, true);
			this.scheduleNote(newNote);
		}
		
		// Redraw notes
		if (this.notesCanvas) {
			this.notesCanvas.activeBars = [];
			const redrawSeconds = 6;
			const currTime = new Date();
			const redrawNotes = History.getRecentHistory(this.currHistory.noteHistory, newTransportSeconds - redrawSeconds);
			for (const note of redrawNotes) {
				const startTime = new Date(currTime);
				const timePassedMilliseconds = (newTransportSeconds - note.time) * 1000;
				startTime.setMilliseconds(startTime.getMilliseconds() - timePassedMilliseconds);
				this.notesCanvas.addNoteBar(note.key, startTime, note.duration, this.pianoAudio.bpm, note.actor, true);
			}
		}
		
		// Wait a short delay before calling model in case user rewinds multiple times
		const startModelDelayMs = 1000;
		if (this.startModelScheduleId) clearTimeout(this.startModelScheduleId);
		this.startModelScheduleId = setTimeout(() => this.startModel(replaySeconds * 1000 - startModelDelayMs), startModelDelayMs);
		
		return true;
	}
	
	replayHistory(idx) {
		this.resetAll();
		const history = this.historyController.allHistories[idx];
		this.currHistory = new History(history.bpm, history.name);
		this.currHistory.lastSeedNoteTime = history.noteHistory.at(-1).time;
		this.currHistory.parentHistory = history;
		this.pianoAudio.setBPM(history.bpm);
		this.pianoAudio.startTone();
		
		if (this.notesCanvas) this.notesCanvas.activeBars = [];
		for (const note of history.noteHistory) {
			const newNote = new Note(note.key, note.velocity, note.duration, note.time, note.actor, null, true);
			this.scheduleNote(newNote);
		}
		this.scheduleStartModel(history.noteHistory.at(-1).time);
	}
	
	async loadSharedHistory(uuid) {
		this.sharedHistory = await this.historyController.getSharedHistory(uuid, this);
		
		if (this.sharedHistory) {
			document.getElementById('introText').style.display = 'none';
			document.getElementById('closeIntroButton').style.display = 'none';
			document.getElementById('introShared').style.display = 'flex';
			
			
			const pianoRoll = new PianoRoll(this.sharedHistory);
			document.getElementById('introCanvasContainer').appendChild(pianoRoll.canvas);
			pianoRoll.draw();
		}
	}
	
	playSharedHistory() {
		if (this.sharedHistory) {
			const historyIdx = this.historyController.allHistories.indexOf(this.sharedHistory);
			if (historyIdx !== -1) {
				this.replayHistory(historyIdx);
			}
		}
		this.sharedHistory = null;
	}
	
	shiftKeyMap(shiftUp) {
		this.releaseAllNotes();
		const prevKeyMapShift = this.keyMapShift;
		if (shiftUp) {
			this.keyMapShift = Math.min(this.keyMapShift + 1, this.octaves * 7 + 2); // Shift up no more than the maximum number of white keys minus 1
		} else {
			this.keyMapShift = Math.max(this.keyMapShift - 1, -(Object.keys(PianoKeyMap.whiteKeyMap).length - 1)); // Shift no down more than the maximum number of white hotkeys minus 1
		}
		
		// Get new keyMap and redraw canvas if shift has changed
		if (prevKeyMapShift !== this.keyMapShift) {
			this.keyMap = PianoKeyMap.getKeyMap(this.keyMapShift, this.pianoKeys.length);
			this.pianoCanvas.getHotkeyMaps();
			this.pianoCanvas.triggerDraw();
		}
	}
	
	bindNotesCanvas(notesCanvas) {
		this.notesCanvas = notesCanvas;
	}
	
	updateContextDateTime() {
		this.contextDateTime = new Date();
		this.contextDateTime.setMilliseconds(this.contextDateTime.getMilliseconds() - (Tone.context.currentTime * 1000));
	}
}
