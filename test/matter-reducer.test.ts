import { describe, expect, it } from 'vitest';
import { Cluster, reduceReports } from '../src/adapters/matter/reducer.js';
import { emptyState } from '../src/schema/index.js';

const report = (clusterId: number, attributeId: number, value: unknown, endpointId = 1) => ({
  endpointId,
  clusterId,
  attributeId,
  value,
});

describe('Matter attribute reducer (port of the app reducer)', () => {
  it('folds on/off, level, and color temperature', () => {
    const { next, changed } = reduceReports(emptyState(), [
      report(Cluster.onOff, 0x0000, true),
      report(Cluster.levelControl, 0x0000, 203),
      report(Cluster.colorControl, 0x0007, 370),
      report(Cluster.colorControl, 0x400b, 153),
      report(Cluster.colorControl, 0x400c, 454),
    ]);
    expect(changed).toBe(true);
    expect(next.onOff).toBe(true);
    expect(next.level).toEqual({ current: 203, min: 1, max: 254 });
    expect(next.colorTemperature).toEqual({ mireds: 370, minMireds: 153, maxMireds: 454 });
  });

  it('clamps level 0 to 1 like the app', () => {
    const { next } = reduceReports(emptyState(), [report(Cluster.levelControl, 0x0000, 0)]);
    expect(next.level?.current).toBe(1);
  });

  it('filters the thermostat null temperature 0x8000', () => {
    const { next, changed } = reduceReports(emptyState(), [
      report(Cluster.thermostat, 0x0000, -32_768),
    ]);
    expect(changed).toBe(false);
    expect(next.thermostat).toBeUndefined();
  });

  it('folds thermostat setpoints, limits, and mode', () => {
    const { next } = reduceReports(emptyState(), [
      report(Cluster.thermostat, 0x0000, 2150),
      report(Cluster.thermostat, 0x0012, 2100),
      report(Cluster.thermostat, 0x0015, 500),
      report(Cluster.thermostat, 0x0016, 3500),
      report(Cluster.thermostat, 0x001c, 4),
    ]);
    expect(next.thermostat?.localTemperatureCenti).toBe(2150);
    expect(next.thermostat?.occupiedHeatingSetpointCenti).toBe(2100);
    expect(next.thermostat?.heatSetpointMinCenti).toBe(500);
    expect(next.thermostat?.heatSetpointMaxCenti).toBe(3500);
    expect(next.thermostat?.systemMode).toBe(4);
  });

  it('decodes covering position, target, and movement bits', () => {
    const { next } = reduceReports(emptyState(), [
      report(Cluster.windowCovering, 0x000e, 2500),
      report(Cluster.windowCovering, 0x000b, 0),
      report(Cluster.windowCovering, 0x000a, 0b01),
    ]);
    expect(next.covering).toEqual({
      currentPositionLiftPercent100ths: 2500,
      targetPositionLiftPercent100ths: 0,
      isMoving: true,
    });
  });

  it('converts sensor units: illuminance log scale, battery half-percents, flow', () => {
    const { next } = reduceReports(emptyState(), [
      report(Cluster.illuminanceMeasurement, 0x0000, 40_001),
      report(Cluster.powerSource, 0x000c, 147),
      report(Cluster.flowMeasurement, 0x0000, 125),
      report(Cluster.temperatureMeasurement, 0x0000, 2156),
      report(Cluster.humidityMeasurement, 0x0000, 4820),
    ]);
    expect(next.sensors.illuminanceLux).toBeCloseTo(10_000, 0);
    expect(next.battery?.percent).toBe(74);
    expect(next.sensors.flowCubicMetersPerHour).toBeCloseTo(12.5);
    expect(next.sensors.temperatureCenti).toBe(2156);
    expect(next.sensors.humidityCenti).toBe(4820);
  });

  it('quantizes power to 0.1 W and accepts bigint values', () => {
    const { next } = reduceReports(emptyState(), [
      report(Cluster.electricalPowerMeasurement, 0x0008, 412_549n),
      report(Cluster.electricalEnergyMeasurement, 0x0001, 12_340_000n),
    ]);
    expect(next.power?.activeMilliwatts).toBe(412_500);
    expect(next.power?.importedEnergyMilliwattHours).toBe(12_340_000);
  });

  it('maps lock, occupancy bitmap, playback, and RVC state', () => {
    const { next } = reduceReports(emptyState(), [
      report(Cluster.doorLock, 0x0000, 1),
      report(Cluster.occupancySensing, 0x0000, 0b11),
      report(Cluster.mediaPlayback, 0x0000, 0),
      report(Cluster.rvcOperationalState, 0x0004, 0x42),
      report(Cluster.rvcRunMode, 0x0001, 2),
    ]);
    expect(next.lock).toBe(1);
    expect(next.sensors.occupied).toBe(true);
    expect(next.playbackPlaying).toBe(true);
    expect(next.rvcOperationalState).toBe(0x42);
    expect(next.currentMode).toBe(2);
  });

  it('reports no change for unknown clusters and attributes', () => {
    const { changed } = reduceReports(emptyState(), [
      report(0x9999, 0x0000, 42),
      report(Cluster.onOff, 0x4001, 42),
    ]);
    expect(changed).toBe(false);
  });
});
