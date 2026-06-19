import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { TranscribeView } from './Transcribe';

// The default-export wrapper just binds useTranscribe → TranscribeView. Mock the hook so we can
// assert the config it receives and that its state flows into the view (no real mic/LLM).
const useTranscribe = vi.fn();
vi.mock('./useTranscribe', () => ({ useTranscribe: (c: unknown) => useTranscribe(c) }));
import Transcribe from './Transcribe';

describe('TranscribeView', () => {
	it('shows the placeholder, then the output', () => {
		const { getByText, rerender } = render(<TranscribeView />);
		expect(getByText(/Click the mic and speak/)).toBeTruthy();
		rerender(<TranscribeView output="hola mundo" />);
		expect(getByText('hola mundo')).toBeTruthy();
	});

	it('shows a listening state while recording and transcribing while busy', () => {
		const { getByText, rerender } = render(<TranscribeView recording />);
		expect(getByText(/Listening/)).toBeTruthy();
		rerender(<TranscribeView busy />);
		expect(getByText(/Transcribing/)).toBeTruthy();
	});

	it('shows the source transcript faintly in translate mode', () => {
		const { getByText } = render(
			<TranscribeView mode="translate" source="hello world" output="hola mundo" />
		);
		expect(getByText('hola mundo')).toBeTruthy();
		expect(getByText('hello world')).toBeTruthy();
	});

	it('toggles the mic and shows recording state', () => {
		const onToggle = vi.fn();
		const { getByLabelText, rerender } = render(<TranscribeView onToggle={onToggle} />);
		fireEvent.click(getByLabelText('Record'));
		expect(onToggle).toHaveBeenCalledOnce();
		rerender(<TranscribeView recording onToggle={onToggle} />);
		expect(getByLabelText('Stop and transcribe')).toBeTruthy();
	});

	it('shows an error', () => {
		const { getByText } = render(<TranscribeView error="no API key" />);
		expect(getByText(/no API key/)).toBeTruthy();
	});
});

describe('Transcribe (container)', () => {
	it('passes its config to useTranscribe and renders the hook state via the view', () => {
		const toggle = vi.fn();
		useTranscribe.mockReturnValue({
			source: 'bonjour',
			output: 'hello',
			busy: false,
			error: '',
			recording: false,
			toggle
		});
		const { getByText, getByLabelText } = render(
			<Transcribe
				mode="translate"
				targetLang="English"
				sourceLang="fr"
				model="whisper-1"
				audioSource="mic-1"
				speak
				label="Live"
			/>
		);
		expect(useTranscribe).toHaveBeenCalledWith({
			mode: 'translate',
			targetLang: 'English',
			sourceLang: 'fr',
			model: 'whisper-1',
			audioSource: 'mic-1',
			speak: true
		});
		expect(getByText('hello')).toBeTruthy(); // translated output
		expect(getByText('bonjour')).toBeTruthy(); // faint source (translate mode)
		expect(getByText('Live')).toBeTruthy();
		fireEvent.click(getByLabelText('Record'));
		expect(toggle).toHaveBeenCalledOnce();
	});

	it('uses the documented defaults when no props are given', () => {
		useTranscribe.mockReturnValue({
			source: '',
			output: '',
			busy: false,
			error: '',
			recording: false,
			toggle: vi.fn()
		});
		render(<Transcribe />);
		expect(useTranscribe).toHaveBeenCalledWith({
			mode: 'transcribe',
			targetLang: 'English',
			sourceLang: 'auto',
			model: '',
			audioSource: '',
			speak: false
		});
	});
});
