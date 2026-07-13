import { describe, it, expect } from 'vitest';
import { normalizeName, normalizeObec, matchTaxDebtor } from '../src/domain/name-match.js';

describe('normalizeName', () => {
  it('diakritika, úvodzovky, interpunkcia, whitespace', () => {
    expect(normalizeName('"Firma  Sedem, s. r. o."')).toBe('firma sedem s r o');
    expect(normalizeName('MÄSIARSTVO Čerešňa, a.s.')).toBe('masiarstvo ceresna a s');
  });
  it('oreže insolvenčné sufixy, právnu formu nechá', () => {
    expect(normalizeName('Firma Deväť s. r. o. v likvidácii')).toBe('firma devat s r o');
    expect(normalizeName('Firma X a.s. v konkurze')).toBe('firma x a s');
  });
  it('zdieľaná základná normalizácia — interpunkcia + insolvenčný sufix', () => {
    expect(normalizeName('Firma, "X" & spol. v likvidácii')).toBe('firma x spol');
  });
});

describe('normalizeObec', () => {
  it('mestské časti zrazí na obec', () => {
    expect(normalizeObec('Bratislava - mestská časť Ružinov')).toBe('bratislava');
    expect(normalizeObec('Košice')).toBe('kosice');
  });
  it('interpunkciu normalizuje rovnako ako normalizeName', () => {
    expect(normalizeObec('Bratislava-Ružinov')).toBe('bratislava ruzinov');
    expect(normalizeObec('Košice, Sever')).toBe('kosice sever');
  });
});

describe('matchTaxDebtor', () => {
  const c = (over = {}) => ({ name: 'X', psc: '82101', obec_norm: 'bratislava', amount_eur: 780, ...over });
  const company = { psc: '821 01', municipality: 'Bratislava - mestská časť Ružinov' };

  it('0 kandidátov → not_found', () => {
    expect(matchTaxDebtor([], company)).toEqual({ status: 'not_found' });
  });
  it('1 kandidát + zhoda PSČ (bez medzier) → exact', () => {
    expect(matchTaxDebtor([c()], company)).toEqual({ status: 'debtor', amount_eur: 780, confidence: 'exact' });
  });
  it('1 kandidát + zhoda len obce → high', () => {
    expect(matchTaxDebtor([c({ psc: '99999' })], company)).toMatchObject({ status: 'debtor', confidence: 'high' });
  });
  it('1 kandidát bez zhody adresy → unverifiable', () => {
    const r = matchTaxDebtor([c({ psc: '04001', obec_norm: 'kosice' })], company);
    expect(r.status).toBe('unverifiable');
  });
  it('2+ kandidáti → unverifiable aj pri zhode adresy', () => {
    const r = matchTaxDebtor([c(), c({ obec_norm: 'kosice' })], company);
    expect(r.status).toBe('unverifiable');
  });
  it('chýbajúca adresa firmy → unverifiable, nie false positive', () => {
    const r = matchTaxDebtor([c()], { psc: null, municipality: null });
    expect(r.status).toBe('unverifiable');
  });
});
