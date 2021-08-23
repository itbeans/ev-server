/* eslint-disable @typescript-eslint/member-ordering */
import { PricingConsumptionData, PricingDefinition, PricingDimension, PricingDimensionData, PricingRestriction, ResolvedPricingModel } from '../../types/Pricing';

import Consumption from '../../types/Consumption';
import PricingStorage from '../../storage/mongodb/PricingStorage';
import Tenant from '../../types/Tenant';
import Transaction from '../../types/Transaction';
import Utils from '../../utils/Utils';

// --------------------------------------------------------------------------------------------------
// TODO - POC - PricingEngine is hidden behind a feature toggle
// --------------------------------------------------------------------------------------------------
export default class PricingEngine {

  static async resolvePricingContext(tenant: Tenant, transaction: Transaction): Promise<ResolvedPricingModel> {
    // -----------------------------------------------------------------------------------------
    // TODO - We need to find the pricing model to apply by resolving the hierarchy of contexts
    // that may override (or extend) the pricing definitions.
    // Forseen hierarchy is:
    // - Tenant/Organization
    // - Company
    // - Site
    // - Site Area
    // - Charging Station
    // - User Group
    // - User
    // Of course, the date has an impact as well
    // -----------------------------------------------------------------------------------------
    // First implementation:
    // - we only have a single pricing model which is defined for the tenant
    // - we simply get the latest created one
    // -----------------------------------------------------------------------------------------
    let pricingModel: ResolvedPricingModel = null;
    const pricingModelResults = await PricingStorage.getPricingModels(tenant, {}, { limit: 1, skip: 0, sort: { createdOn: -1 } });
    if (pricingModelResults.count > 0) {
      const { pricingDefinitions } = pricingModelResults.result[0];
      pricingModel = {
        pricingDefinitions
      };
    }
    // TODO - No pricing definition? => Throw an exception ?
    return Promise.resolve(pricingModel);
  }

  static checkPricingDefinitionRestrictions(pricingDefinition: PricingDefinition, consumptionData: Consumption) : PricingDefinition {
    if (pricingDefinition.restrictions) {
      if (!PricingEngine.checkRestrictionMinPower(pricingDefinition.restrictions, consumptionData)
        || !PricingEngine.checkRestrictionMaxPower(pricingDefinition.restrictions, consumptionData)
        || !PricingEngine.checkRestrictionMinDuration(pricingDefinition.restrictions, consumptionData)
        || !PricingEngine.checkRestrictionMaxDuration(pricingDefinition.restrictions, consumptionData)) {
        // -----------------------------------------------------------------------------------------
        // TODO - to be clarified - why don't we put "date validity" at the pricing model level????
        // -----------------------------------------------------------------------------------------
        // startTime?: string, // Start time of day, for example 13:30, valid from this time of the day. Must be in 24h format with leading zeros. Hour/Minute se
        // endTime?: string, // End time of day, for example 19:45, valid until this time of the day. Same syntax as start_time
        // startDate?: string, // Start date, for example: 2015-12-24, valid from this day
        // endDate?: string, // End date, for example: 2015-12-27, valid until this day (excluding this day)
        // daysOfWeek?: DayOfWeek[], // Which day(s) of the week this tariff is valid
        return null;
      }
    }
    // a definition matching the restrictions has been found
    return pricingDefinition;
  }

  static checkRestrictionMinPower(restrictions: PricingRestriction, consumptionData: Consumption): boolean {
    if (!Utils.isNullOrUndefined(restrictions.minPowerkW)) {
      if (Utils.createDecimal(consumptionData.cumulatedConsumptionWh).dividedBy(1000).lessThan(restrictions.minPowerkW)) {
        return false;
      }
    }
    return true;
  }

  static checkRestrictionMaxPower(restrictions: PricingRestriction, consumptionData: Consumption): boolean {
    if (!Utils.isNullOrUndefined(restrictions.maxPowerkW)) {
      if (Utils.createDecimal(consumptionData.cumulatedConsumptionWh).dividedBy(1000).greaterThanOrEqualTo(restrictions.maxPowerkW)) {
        return false;
      }
    }
    return true;
  }

  static checkRestrictionMinDuration(restrictions: PricingRestriction, consumptionData: Consumption): boolean {
    if (!Utils.isNullOrUndefined(restrictions.minDurationSecs)) {
      if (Utils.createDecimal(consumptionData.totalDurationSecs).lessThan(restrictions.minDurationSecs)) {
        return false;
      }
    }
    return true;
  }

  static checkRestrictionMaxDuration(restrictions: PricingRestriction, consumptionData: Consumption): boolean {
    if (!Utils.isNullOrUndefined(restrictions.maxDurationSecs)) {
      if (Utils.createDecimal(consumptionData.totalDurationSecs).greaterThanOrEqualTo(restrictions.maxDurationSecs)) {
        return false;
      }
    }
    return true;
  }

  static async priceFinalConsumption(tenant: Tenant, transaction: Transaction, consumptionData: Consumption): Promise<PricingConsumptionData> {
    // Check the restrictions to find the pricing definition matching the current context
    const actualPricingDefinitions = transaction.pricingModel.pricingDefinitions.filter((pricingDefinition) =>
      PricingEngine.checkPricingDefinitionRestrictions(pricingDefinition, consumptionData)
    );
    // Build the consumption data for each dimension
    const flatFee: PricingDimensionData = PricingEngine.priceFlatFeeConsumption(actualPricingDefinitions, consumptionData);
    const energy: PricingDimensionData = PricingEngine.priceEnergyConsumption(actualPricingDefinitions, consumptionData);
    const chargingTime: PricingDimensionData = PricingEngine.priceChargingTimeConsumption(actualPricingDefinitions, consumptionData);
    const parkingTime: PricingDimensionData = PricingEngine.priceParkingTimeConsumption(actualPricingDefinitions, consumptionData);
    // For now we can have up to 4 dimensions
    const pricingConsumptionData: PricingConsumptionData = {
      flatFee,
      energy,
      chargingTime,
      parkingTime,
    };
    // Remove unset properties
    if (!pricingConsumptionData.flatFee) {
      delete pricingConsumptionData.flatFee;
    }
    if (!pricingConsumptionData.energy) {
      delete pricingConsumptionData.energy;
    }
    if (!pricingConsumptionData.chargingTime) {
      delete pricingConsumptionData.chargingTime;
    }
    if (!pricingConsumptionData.parkingTime) {
      delete pricingConsumptionData.parkingTime;
    }
    return Promise.resolve(pricingConsumptionData);
  }

  private static priceFlatFeeConsumption(pricingDefinitions: PricingDefinition[], consumptionData: Consumption): PricingDimensionData {
    let pricingDimensionData: PricingDimensionData = null;
    const quantity = 1; // To be clarified - Flat Fee is billing billed once per sessions
    pricingDimensionData = PricingEngine.PriceDimensionConsumption(pricingDefinitions, 'flatFee', quantity);
    return pricingDimensionData;
  }

  private static priceEnergyConsumption(pricingDefinitions: PricingDefinition[], consumptionData: Consumption): PricingDimensionData {
    let pricingDimensionData: PricingDimensionData = null;
    const quantity = Utils.createDecimal(consumptionData?.cumulatedConsumptionWh).dividedBy(1000).toNumber(); // Total consumption in kW.h
    pricingDimensionData = PricingEngine.PriceDimensionConsumption(pricingDefinitions, 'energy', quantity);
    return pricingDimensionData;
  }

  private static priceParkingTimeConsumption(pricingDefinitions: PricingDefinition[], consumptionData: Consumption): PricingDimensionData {
    let pricingDimensionData: PricingDimensionData = null;
    const hours = Utils.createDecimal(consumptionData?.totalInactivitySecs).dividedBy(3600).toNumber();
    pricingDimensionData = PricingEngine.PriceDimensionConsumption(pricingDefinitions, 'parkingTime', hours);
    return pricingDimensionData;
  }

  private static priceChargingTimeConsumption(pricingDefinitions: PricingDefinition[], consumptionData: Consumption): PricingDimensionData {
    let pricingDimensionData: PricingDimensionData = null;
    const hours = Utils.createDecimal(consumptionData?.totalDurationSecs).dividedBy(3600).toNumber();
    pricingDimensionData = PricingEngine.PriceDimensionConsumption(pricingDefinitions, 'chargingTime', hours);
    return pricingDimensionData;
  }

  static PriceDimensionConsumption(actualPricingDefinitions: PricingDefinition[], dimensionType: string, quantity = 0): PricingDimensionData {
    // Search for the first pricing definition matching the current dimension type
    const activePricingDefinitions = actualPricingDefinitions.filter((pricingDefinition) =>
      // We search for a pricing definition where the current dimension exists
      PricingEngine.checkPricingDimensionRestrictions(pricingDefinition, dimensionType)
    );
    // Iterate throw the list of pricing definitions where the current dimension makes sense
    let pricingDimensionData: PricingDimensionData = null;
    for (const activePricingDefinition of activePricingDefinitions) {
      const dimensionToPrice = activePricingDefinition.dimensions[dimensionType];
      if (dimensionToPrice) {
        pricingDimensionData = PricingEngine.priceDimension(dimensionToPrice, quantity);
        if (pricingDimensionData) {
          // TODO - clarify where to show the actual tariff name
          pricingDimensionData.itemDescription = activePricingDefinition.name;
          break;
        }
      }
    }
    return pricingDimensionData;
  }

  static checkPricingDimensionRestrictions(pricingDefinition: PricingDefinition, dimensionType: string) : PricingDefinition {
    const pricingDimension: PricingDimension = pricingDefinition.dimensions[dimensionType];
    if (pricingDimension?.active) {
      return pricingDefinition;
    }
    return null;
  }

  static priceDimension(pricingDimension: PricingDimension, quantity: number): PricingDimensionData {
    let amount: number;
    if (pricingDimension.stepSize) {
      // --------------------------------------------------------------------------------------------
      // Step Size - Minimum amount to be billed. This unit will be billed in this step_size blocks.
      // For example:
      //  if type is time and step_size is 300, then time will be billed in blocks of 5 minutes,
      //  so if 6 minutes is used, 10 minutes (2 blocks of step_size) will be billed.
      // --------------------------------------------------------------------------------------------
      const nbSteps = Utils.createDecimal(quantity).modulo(pricingDimension.stepSize).toNumber();
      amount = Utils.createDecimal(pricingDimension.price).times(nbSteps).toNumber();
    } else {
      amount = Utils.createDecimal(pricingDimension.price).times(quantity).toNumber();
    }
    const pricingDimensionData: PricingDimensionData = {
      amount,
      quantity
    };
    return pricingDimensionData;
  }

}

