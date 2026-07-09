import { describe, expect, it } from 'vitest';
import {
	currencySymbol,
	direction,
	directionArrow,
	formatChangeAbs,
	formatChangePct,
	formatPrice,
	marketLabel
} from './tickerFormat';

describe('direction', () => {
	it('maps sign to up/down/flat (null/0/NaN → flat)', () => {
		expect(direction(1.2)).toBe('up');
		expect(direction(-0.1)).toBe('down');
		expect(direction(0)).toBe('flat');
		expect(direction(null)).toBe('flat');
		expect(direction(NaN)).toBe('flat');
	});
	it('arrows', () => {
		expect(directionArrow('up')).toBe('▲');
		expect(directionArrow('down')).toBe('▼');
		expect(directionArrow('flat')).toBe('·');
	});
});

describe('formatPrice', () => {
	it('groups thousands and respects decimals', () => {
		expect(formatPrice(1234.5, 2)).toBe('1,234.50');
		expect(formatPrice(1234567, 0)).toBe('1,234,567');
		expect(formatPrice(9.999, 2)).toBe('10.00');
		expect(formatPrice(-1234.5, 2)).toBe('-1,234.50');
	});
	it('shows an em dash for no value', () => {
		expect(formatPrice(null)).toBe('—');
		expect(formatPrice(undefined)).toBe('—');
		expect(formatPrice(NaN)).toBe('—');
	});
	it('clamps decimals to a sane range', () => {
		expect(formatPrice(1.23456789, 99)).toBe('1.234568'); // capped at 6
		expect(formatPrice(1.5, -5)).toBe('2'); // floored at 0
	});
});

describe('formatChangePct / formatChangeAbs', () => {
	it('adds an explicit + for gains; - rides on the number', () => {
		expect(formatChangePct(1.234)).toBe('+1.23%');
		expect(formatChangePct(-0.5)).toBe('-0.50%');
		expect(formatChangePct(0)).toBe('0.00%');
		expect(formatChangePct(null)).toBe('');
	});
	it('signs the absolute change', () => {
		expect(formatChangeAbs(1.2, 2)).toBe('+1.20');
		expect(formatChangeAbs(-1234.5, 2)).toBe('-1,234.50');
		expect(formatChangeAbs(0)).toBe('0.00'); // neither gain nor loss → no sign
		expect(formatChangeAbs(null)).toBe('');
	});
});

describe('currencySymbol', () => {
	it('maps known codes, blanks unknown', () => {
		expect(currencySymbol('USD')).toBe('$');
		expect(currencySymbol('eur')).toBe('€');
		expect(currencySymbol('SEK')).toBe('');
		expect(currencySymbol(null)).toBe('');
	});
});

describe('marketLabel', () => {
	it('blanks a regular/open session, labels the rest', () => {
		expect(marketLabel('REGULAR')).toBe('');
		expect(marketLabel('')).toBe('');
		expect(marketLabel('PRE')).toBe('pre-market');
		expect(marketLabel('PREPRE')).toBe('pre-market');
		expect(marketLabel('POST')).toBe('after hours');
		expect(marketLabel('POSTPOST')).toBe('after hours');
		expect(marketLabel('CLOSED')).toBe('closed');
		expect(marketLabel('weird')).toBe('weird');
	});
	it('blanks a missing state (null/undefined) same as an open session', () => {
		expect(marketLabel(null)).toBe('');
		expect(marketLabel(undefined)).toBe('');
	});
});
