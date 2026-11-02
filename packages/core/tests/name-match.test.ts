import { describe, it, expect } from 'vitest';
import { normalizeName, normalizeObec, matchTaxDebtor } from '../src/domain/name-match.js';

describe('normalizeName', () => {
  it('diakritika, úvodzovky, interpunkcia, whitespace', () => {
    expect(normalizeName('"Firma  Sedem, s. r. o."')).toBe('firma sedem s r o');
    expect(normalizeName('FIRMA Štvorlístok Ďaleko, a.s.')).toBe('firma stvorlistok daleko a s');
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
  const c = (over = {}) => ({ name: 'X', psc: '82101', obec_norm: 'bratislava', street: 'Vzorová 12/3', amount_eur: 780, ...over });
  // obchodný register: meno je zo zákona jedinečné
  const company = { psc: '821 01', municipality: 'Bratislava - mestská časť Ružinov', building_number: '12/3', unique_name: true };

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
    const r = matchTaxDebtor([c()], { psc: null, municipality: null, building_number: null, unique_name: true });
    expect(r.status).toBe('unverifiable');
  });

  describe('subjekt mimo obchodného registra (živnostník, združenie) — meno nie je jedinečné', () => {
    const person = { ...company, street: 'Vzorová', unique_name: false };
    it('zhoda PSČ, ulice aj čísla domu → exact', () => {
      expect(matchTaxDebtor([c()], person)).toEqual({ status: 'debtor', amount_eur: 780, confidence: 'exact' });
    });
    it('rôzna interpunkcia a diakritika nevadí', () => {
      expect(matchTaxDebtor([c({ street: 'VZOROVA 12 / 3' })], person).status).toBe('debtor');
    });
    it('obec bez ulíc: len číslo na oboch stranách → exact', () => {
      expect(matchTaxDebtor([c({ street: '141' })], { ...person, street: null, building_number: '141' }).status).toBe('debtor');
    });
    it('rovnaké číslo na inej ulici → unverifiable', () => {
      expect(matchTaxDebtor([c({ street: 'Iná ulica 12/3' })], person).status).toBe('unverifiable');
    });
    it('číslo sa musí zhodovať celé, nie len koncom', () => {
      expect(matchTaxDebtor([c({ street: 'Vzorová 112/3' })], person).status).toBe('unverifiable');
      expect(matchTaxDebtor([c({ street: 'Vzorová 5/12/3' })], person).status).toBe('unverifiable');
      expect(matchTaxDebtor([c({ street: 'Vzorová 1953/3' })], { ...person, building_number: '3' }).status).toBe('unverifiable');
    });
    it('ulica len na jednej strane → unverifiable', () => {
      expect(matchTaxDebtor([c({ street: '12/3' })], person).status).toBe('unverifiable');
    });
    it('zhoda len obce (iná mestská časť) → unverifiable, nie dlžník', () => {
      const r = matchTaxDebtor([c({ psc: '85101' })], person);
      expect(r.status).toBe('unverifiable');
      if (r.status === 'unverifiable') expect(r.note).toMatch(/obchodného registra/);
    });
    it('chýba číslo domu → unverifiable', () => {
      expect(matchTaxDebtor([c()], { ...person, building_number: null }).status).toBe('unverifiable');
      expect(matchTaxDebtor([c({ street: null })], person).status).toBe('unverifiable');
    });
  });
});
