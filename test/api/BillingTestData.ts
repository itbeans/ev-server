/* eslint-disable max-len */
import AsyncTask, { AsyncTaskStatus } from '../../src/types/AsyncTask';
import { BillingDataTransactionStop, BillingInvoice, BillingInvoiceStatus, BillingStatus, BillingUser } from '../../src/types/Billing';
import { BillingSettings, BillingSettingsType, SettingDB } from '../../src/types/Setting';
import ChargingStation, { ConnectorType } from '../../src/types/ChargingStation';
import FeatureToggles, { Feature } from '../../src/utils/FeatureToggles';
import PricingDefinition, { PricingDimension, PricingDimensions, PricingEntity, PricingRestriction } from '../../src/types/Pricing';
import chai, { assert, expect } from 'chai';

import AsyncTaskStorage from '../../src/storage/mongodb/AsyncTaskStorage';
import CentralServerService from './client/CentralServerService';
import ChargingStationContext from './context/ChargingStationContext';
import Constants from '../../src/utils/Constants';
import ContextDefinition from './context/ContextDefinition';
import ContextProvider from './context/ContextProvider';
import Cypher from '../../src/utils/Cypher';
import { DataResult } from '../../src/types/DataResult';
import Decimal from 'decimal.js';
import SiteAreaContext from './context/SiteAreaContext';
import SiteContext from './context/SiteContext';
import { StatusCodes } from 'http-status-codes';
import Stripe from 'stripe';
import StripeBillingIntegration from '../../src/integration/billing/stripe/StripeBillingIntegration';
import { TenantComponents } from '../../src/types/Tenant';
import TenantContext from './context/TenantContext';
import TestConstants from './client/utils/TestConstants';
import TestUtils from './TestUtils';
import User from '../../src/types/User';
import Utils from '../../src/utils/Utils';
import chaiSubset from 'chai-subset';
import config from '../config';
import moment from 'moment';
import responseHelper from '../helpers/responseHelper';

chai.use(chaiSubset);
chai.use(responseHelper);

export default class BillingTestData {
  // Tenant: utbilling
  public tenantContext: TenantContext;
  // User Service for action requiring admin permissions (e.g.: set/reset stripe settings)
  public adminUserContext: User;
  public adminUserService: CentralServerService;
  // User Service for common actions
  public userContext: User;
  public userService: CentralServerService;
  // Other test resources
  public siteContext: SiteContext;
  public siteAreaContext: SiteAreaContext;
  public chargingStationContext: ChargingStationContext;
  public createdUsers: User[] = [];
  // Dynamic User for testing billing against an empty STRIPE account
  // Billing Implementation - STRIPE?
  public billingImpl: StripeBillingIntegration;
  public billingUser: BillingUser; // DO NOT CONFUSE - BillingUser is not a User!

  public async initialize() : Promise<void> {
    this.tenantContext = await ContextProvider.defaultInstance.getTenantContext(ContextDefinition.TENANT_CONTEXTS.TENANT_BILLING);
    this.adminUserContext = this.tenantContext.getUserContext(ContextDefinition.USER_CONTEXTS.DEFAULT_ADMIN);
    this.adminUserService = new CentralServerService(
      this.tenantContext.getTenant().subdomain,
      this.adminUserContext
    );
  }

  public async assignPaymentMethod(user: BillingUser, stripe_test_token: string) : Promise<Stripe.CustomerSource> {
    // Assign a source using test tokens (instead of test card numbers)
    // c.f.: https://stripe.com/docs/testing#cards
    const concreteImplementation : StripeBillingIntegration = this.billingImpl ;
    const stripeInstance = await concreteImplementation.getStripeInstance();
    const customerID = user.billingData?.customerID;
    assert(customerID, 'customerID should not be null');
    // TODO - rethink that part - the concrete billing implementation should be called instead
    const source = await stripeInstance.customers.createSource(customerID, {
      source: stripe_test_token // e.g.: tok_visa, tok_amex, tok_fr
    });
    assert(source, 'Source should not be null');
    // TODO - rethink that part - the concrete billing implementation should be called instead
    const customer = await stripeInstance.customers.update(customerID, {
      default_source: source.id
    });
    assert(customer, 'Customer should not be null');
    return source;
  }

  public initUserContextAsAdmin() : void {
    expect(this.userContext).to.not.be.null;
    this.userContext = this.adminUserContext;
    assert(this.userContext, 'User context cannot be null');
    this.userService = this.adminUserService;
    assert(!!this.userService, 'User service cannot be null');
  }

  public async initChargingStationContext() : Promise<ChargingStationContext> {
    this.siteContext = this.tenantContext.getSiteContext(ContextDefinition.SITE_CONTEXTS.SITE_WITH_OTHER_USER_STOP_AUTHORIZATION);
    this.siteAreaContext = this.siteContext.getSiteAreaContext(ContextDefinition.SITE_AREA_CONTEXTS.WITH_ACL);
    this.chargingStationContext = this.siteAreaContext.getChargingStationContext(ContextDefinition.CHARGING_STATION_CONTEXTS.ASSIGNED_OCPP16);
    assert(!!this.chargingStationContext, 'Charging station context should not be null');
    // -------------------------------------------------
    // No pricing definition here!
    // -------------------------------------------------
    // await this.createTariff4ChargingStation(this.chargingStationContext.getChargingStation());
    return Promise.resolve(this.chargingStationContext);
  }

  public async initChargingStationContext2TestChargingTime() : Promise<ChargingStationContext> {
    this.siteContext = this.tenantContext.getSiteContext(ContextDefinition.SITE_CONTEXTS.SITE_BASIC);
    this.siteAreaContext = this.siteContext.getSiteAreaContext(ContextDefinition.SITE_AREA_CONTEXTS.WITH_SMART_CHARGING_THREE_PHASED);
    this.chargingStationContext = this.siteAreaContext.getChargingStationContext(ContextDefinition.CHARGING_STATION_CONTEXTS.ASSIGNED_OCPP16 + '-' + ContextDefinition.SITE_CONTEXTS.SITE_BASIC + '-' + ContextDefinition.SITE_AREA_CONTEXTS.WITH_SMART_CHARGING_THREE_PHASED + '-singlePhased');
    assert(!!this.chargingStationContext, 'Charging station context should not be null');
    await this.createTariff4ChargingStation('FF+CT', this.chargingStationContext.getChargingStation(), {
      flatFee: {
        price: 1,
        active: true
      },
      chargingTime: {
        price: 0.4,
        active: true
      }
    });
    return this.chargingStationContext;
  }

  public async initChargingStationContext2TestCS3Phased(testMode = 'FF+E') : Promise<ChargingStationContext> {
    this.siteContext = this.tenantContext.getSiteContext(ContextDefinition.SITE_CONTEXTS.SITE_BASIC);
    this.siteAreaContext = this.siteContext.getSiteAreaContext(ContextDefinition.SITE_AREA_CONTEXTS.WITH_SMART_CHARGING_THREE_PHASED);
    this.chargingStationContext = this.siteAreaContext.getChargingStationContext(ContextDefinition.CHARGING_STATION_CONTEXTS.ASSIGNED_OCPP16 + '-' + ContextDefinition.SITE_CONTEXTS.SITE_BASIC + '-' + ContextDefinition.SITE_AREA_CONTEXTS.WITH_SMART_CHARGING_THREE_PHASED);
    assert(!!this.chargingStationContext, 'Charging station context should not be null');
    let dimensions: PricingDimensions;
    if (testMode === 'FF+E(STEP)') {
      dimensions = {
        flatFee: {
          price: 2,
          active: true
        },
        energy: {
          price: 0.25, // 25 cents per kWh
          stepSize: 5000, // Step Size - 5 kWh
          active: true
        }
      };
    } else {
      dimensions = {
        flatFee: {
          price: 2,
          active: true
        },
        energy: {
          price: 0.25,
          active: true
        },
        chargingTime: {
          price: 777, // THIS IS OFF
          active: false
        }
      };
    }
    await this.createTariff4ChargingStation(testMode, this.chargingStationContext.getChargingStation(), dimensions);
    return this.chargingStationContext;
  }

  public async initChargingStationContext2TestFastCharger(testMode = 'E') : Promise<ChargingStationContext> {
    this.siteContext = this.tenantContext.getSiteContext(ContextDefinition.SITE_CONTEXTS.SITE_BASIC);
    this.siteAreaContext = this.siteContext.getSiteAreaContext(ContextDefinition.SITE_AREA_CONTEXTS.WITH_SMART_CHARGING_DC);
    this.chargingStationContext = this.siteAreaContext.getChargingStationContext(ContextDefinition.CHARGING_STATION_CONTEXTS.ASSIGNED_OCPP16 + '-' + ContextDefinition.SITE_CONTEXTS.SITE_BASIC + '-' + ContextDefinition.SITE_AREA_CONTEXTS.WITH_SMART_CHARGING_DC);
    assert(!!this.chargingStationContext, 'Charging station context should not be null');

    let dimensions: PricingDimensions;
    let restrictions: PricingRestriction;
    if (testMode === 'FF+CT+PT') {
      dimensions = {
        flatFee: {
          price: 1, // Euro
          active: true
        },
        chargingTime: {
          price: 5, // Euro per hour
          active: true
        },
        parkingTime: {
          price: 10, // Euro per hour
          active: true
        }
      };
    } else if (testMode === 'CT(STEP)+PT(STEP)') {
      dimensions = {
        chargingTime: {
          price: 12, // Euro per hour
          stepSize: 300, // 300 seconds == 5 minutes
          active: true
        },
        parkingTime: {
          price: 20, // Euro per hour
          stepSize: 3 * 60, // 3 minutes
          active: true
        }
      };
    } else if (testMode === 'E+PT(STEP)') {
      dimensions = {
        energy: {
          price: 0.50,
          active: true
        },
        parkingTime: {
          price: 20, // Euro per hour
          stepSize: 120, // 120 seconds == 2 minutes
          active: true
        }
      };
    } else if (testMode === 'E-After30mins') {
      // Create a second tariff with a different pricing strategy
      dimensions = {
        energy: {
          price: 0.70,
          active: true
        },
        parkingTime: {
          price: 20, // Euro per hour
          active: true
        }
      };
      restrictions = {
        minDurationSecs: 30 * 60 // Apply this tariff after 30 minutes
      };
    } else if (testMode === 'FF+E(STEP)-MainTariff') {
      dimensions = {
        flatFee: {
          price: 2,
          active: true
        },
        energy: {
          price: 1, // 25 cents per kWh
          stepSize: 3000, // Step Size - 3kWh
          active: true
        }
      };
    } else if (testMode === 'E(STEP)-After30mins') {
      // Create a second tariff with a different pricing strategy
      dimensions = {
        energy: {
          price: 0.5,
          stepSize: 4000, // Step Size - 4kWh
          active: true
        }
      };
      restrictions = {
        minDurationSecs: 30 * 60 // Apply this tariff after 30 minutes
      };
    } else if (testMode === 'FF+E') {
      dimensions = {
        flatFee: {
          price: 1.5, // Euro
          active: true
        },
        energy: {
          price: 0.50,
          active: true
        }
      };
    } else {
      dimensions = {
        energy: {
          price: 0.50,
          active: true
        }
      };
    }
    await this.createTariff4ChargingStation(testMode, this.chargingStationContext.getChargingStation(), dimensions, ConnectorType.COMBO_CCS, restrictions);
    return this.chargingStationContext;
  }

  public async setBillingSystemValidCredentials(activateTransactionBilling = true, immediateBillingAllowed = false) : Promise<StripeBillingIntegration> {
    const billingSettings = this.getLocalSettings(immediateBillingAllowed);
    // Here we switch ON or OFF the billing of charging sessions
    billingSettings.billing.isTransactionBillingActivated = activateTransactionBilling;
    // Invoke the generic setting service API to properly persist this information
    await this.saveBillingSettings(billingSettings);
    const tenant = this.tenantContext?.getTenant();
    assert(!!tenant, 'Tenant cannot be null');
    billingSettings.stripe.secretKey = await Cypher.encrypt(tenant, billingSettings.stripe.secretKey);
    const billingImpl = StripeBillingIntegration.getInstance(tenant, billingSettings);
    assert(billingImpl, 'Billing implementation should not be null');
    return billingImpl;
  }

  public async setBillingSystemInvalidCredentials() : Promise<StripeBillingIntegration> {
    const billingSettings = this.getLocalSettings(false);
    const tenant = this.tenantContext?.getTenant();
    assert(!!tenant, 'Tenant cannot be null');
    billingSettings.stripe.secretKey = await Cypher.encrypt(tenant, 'sk_test_' + 'invalid_credentials');
    await this.saveBillingSettings(billingSettings);
    const billingImpl = StripeBillingIntegration.getInstance(tenant, billingSettings);
    assert(billingImpl, 'Billing implementation should not be null');
    return billingImpl;
  }

  public getLocalSettings(immediateBillingAllowed: boolean): BillingSettings {
    // ---------------------------------------------------------------------
    // ACHTUNG: Our test may need the immediate billing to be switched off!
    // Because we want to check the DRAFT state of the invoice
    // ---------------------------------------------------------------------
    const billingProperties = {
      isTransactionBillingActivated: true, // config.get('billing.isTransactionBillingActivated'),
      immediateBillingAllowed: immediateBillingAllowed, // config.get('billing.immediateBillingAllowed'),
      periodicBillingAllowed: !immediateBillingAllowed, // config.get('billing.periodicBillingAllowed'),
      taxID: config.get('billing.taxID')
    };
    const stripeProperties = {
      url: config.get('stripe.url'),
      publicKey: config.get('stripe.publicKey'),
      secretKey: config.get('stripe.secretKey'),
    };
    const settings: BillingSettings = {
      identifier: TenantComponents.BILLING,
      type: BillingSettingsType.STRIPE,
      billing: billingProperties,
      stripe: stripeProperties,
    };
    return settings;
  }

  public async saveBillingSettings(billingSettings: BillingSettings) : Promise<void> {
    // TODO - rethink that part
    const tenantBillingSettings = await this.adminUserService.settingApi.readAll({ 'Identifier': 'billing' });
    expect(tenantBillingSettings.data.count).to.be.eq(1);
    const componentSetting: SettingDB = tenantBillingSettings.data.result[0];
    componentSetting.content.type = BillingSettingsType.STRIPE;
    componentSetting.content.billing = billingSettings.billing;
    componentSetting.content.stripe = billingSettings.stripe;
    componentSetting.sensitiveData = ['content.stripe.secretKey'];
    await this.adminUserService.settingApi.update(componentSetting);
  }

  public async checkTransactionBillingData(transactionId: number, expectedInvoiceStatus: BillingInvoiceStatus, expectedPrice: number = null) : Promise<void> {
    // Check the transaction status
    const transactionResponse = await this.adminUserService.transactionApi.readById(transactionId);
    expect(transactionResponse.status).to.equal(StatusCodes.OK);
    assert(transactionResponse.data?.billingData, 'Billing Data should be set');
    const billingDataStop: BillingDataTransactionStop = transactionResponse.data.billingData.stop;
    expect(billingDataStop?.status).to.equal(BillingStatus.BILLED);
    assert(billingDataStop?.invoiceID, 'Invoice ID should be set');
    assert(billingDataStop?.invoiceStatus === expectedInvoiceStatus, `The invoice status should be ${expectedInvoiceStatus}`);
    if (expectedInvoiceStatus !== BillingInvoiceStatus.DRAFT) {
      assert(billingDataStop?.invoiceNumber, 'Invoice Number should be set');
    } else {
      assert(billingDataStop?.invoiceNumber === null, `Invoice Number should not yet been set - Invoice Number is: ${billingDataStop?.invoiceNumber}`);
    }
    if (expectedPrice) {
      if (!FeatureToggles.isFeatureActive(Feature.PRICING_NEW_MODEL)
        || FeatureToggles.isFeatureActive(Feature.PRICING_CHECK_BACKWARD_COMPATIBILITY)) {
        expectedPrice = 32.32; // Expected price when using the Simple Pricing logic!
      }
      // --------------------------------
      // Check transaction rounded price
      // --------------------------------
      const roundedPrice = Utils.createDecimal(transactionResponse.data.stop.roundedPrice);
      assert(roundedPrice.equals(expectedPrice), `The rounded price should be: ${expectedPrice} - actual value: ${roundedPrice.toNumber()}`);
      // ---------------------------
      // Check priced dimensions
      // ---------------------------
      const billedPrice = this.getBilledRoundedPrice(billingDataStop);
      assert(billedPrice.equals(expectedPrice), `The billed price should be: ${expectedPrice} - actual value: ${billedPrice.toNumber()}`);
    }
  }

  public getBilledRoundedPrice(billingDataStop: BillingDataTransactionStop): Decimal {
    let roundedPrice = Utils.createDecimal(0);
    const invoiceItem = billingDataStop.invoiceItem;
    if (invoiceItem) {
      invoiceItem.pricingData.forEach((pricedConsumptionData) => {
        roundedPrice = roundedPrice.plus(pricedConsumptionData.flatFee?.roundedAmount || 0);
        roundedPrice = roundedPrice.plus(pricedConsumptionData.energy?.roundedAmount || 0);
        roundedPrice = roundedPrice.plus(pricedConsumptionData.parkingTime?.roundedAmount || 0);
        roundedPrice = roundedPrice.plus(pricedConsumptionData.chargingTime?.roundedAmount || 0);
      });
    }
    return roundedPrice;
  }

  public async generateTransaction(user: any, expectedStatus = 'Accepted'): Promise<number> {

    const meterStart = 0;
    const meterStop = 32325; // Unit: Wh
    const meterValue1 = Utils.createDecimal(meterStop).divToInt(80).toNumber();
    const meterValue2 = Utils.createDecimal(meterStop).divToInt(30).toNumber();
    const meterValue3 = Utils.createDecimal(meterStop).divToInt(60).toNumber();

    // const user:any = this.userContext;
    const connectorId = 1;
    assert((user.tags && user.tags.length), 'User must have a valid tag');
    const tagId = user.tags[0].id;
    // # Begin
    const startDate = moment();
    const startTransactionResponse = await this.chargingStationContext.startTransaction(connectorId, tagId, meterStart, startDate.toDate());
    expect(startTransactionResponse).to.be.transactionStatus(expectedStatus);
    const transactionId = startTransactionResponse.transactionId;

    const currentTime = startDate.clone();
    let cumulated = 0;
    // Phase #0
    for (let index = 0; index < 5; index++) {
      // cumulated += meterValue1; - not charging yet!
      await this.sendConsumptionMeterValue(connectorId, transactionId, currentTime, cumulated);
    }
    // Phase #1
    for (let index = 0; index < 15; index++) {
      cumulated += meterValue1;
      await this.sendConsumptionMeterValue(connectorId, transactionId, currentTime, cumulated);
    }
    // Phase #2
    for (let index = 0; index < 20; index++) {
      cumulated += meterValue2;
      await this.sendConsumptionMeterValue(connectorId, transactionId, currentTime, cumulated);
    }
    // Phase #3
    for (let index = 0; index < 15; index++) {
      cumulated = Math.min(meterStop, cumulated += meterValue3);
      await this.sendConsumptionMeterValue(connectorId, transactionId, currentTime, cumulated);
    }
    assert(cumulated === meterStop, 'Inconsistent meter values - cumulated energy should equal meterStop - ' + cumulated);
    // Phase #4 - parking time
    for (let index = 0; index < 4; index++) {
      // cumulated += 0; // Parking time - not charging anymore
      await this.sendConsumptionMeterValue(connectorId, transactionId, currentTime, meterStop);
    }

    // #end
    const stopDate = startDate.clone().add(1, 'hour');
    if (expectedStatus === 'Accepted') {
      const stopTransactionResponse = await this.chargingStationContext.stopTransaction(transactionId, tagId, meterStop, stopDate.toDate());
      expect(stopTransactionResponse).to.be.transactionStatus('Accepted');
    }
    // Give some time to the asyncTask to bill the transaction
    await this.waitForAsyncTasks();
    return transactionId;
  }

  public async sendConsumptionMeterValue(connectorId: number, transactionId: number, currentTime: moment.Moment, energyActiveImportMeterValue: number): Promise<void> {
    currentTime.add(1, 'minute');
    const meterValueResponse = await this.chargingStationContext.sendConsumptionMeterValue(
      connectorId,
      transactionId,
      currentTime.toDate(), {
        energyActiveImportMeterValue
      }
    );
    expect(meterValueResponse).to.eql({});
  }

  public async waitForAsyncTasks(): Promise<void> {
    let counter = 0, pending: DataResult<AsyncTask>, running: DataResult<AsyncTask>;
    while (counter++ <= 10) {
      // Get the number of pending tasks
      pending = await AsyncTaskStorage.getAsyncTasks({ status: AsyncTaskStatus.PENDING }, Constants.DB_PARAMS_COUNT_ONLY);
      running = await AsyncTaskStorage.getAsyncTasks({ status: AsyncTaskStatus.RUNNING }, Constants.DB_PARAMS_COUNT_ONLY);
      if (!pending.count && !running.count) {
        break;
      }
      // Give some time to the asyncTask to bill the transaction
      console.log(`Waiting for async tasks - pending tasks: ${pending.count} - running tasks: ${running.count}`);
      await TestUtils.sleep(1000);
    }
    if (!pending.count && !running.count) {
      console.log('Async tasks have been completed');
    } else {
      console.warn(`Gave up after more than 10 seconds - pending tasks: ${pending.count} - running tasks: ${running.count}`);
    }
  }

  public async checkForDraftInvoices(userId?: string): Promise<number> {
    const result = await this.getDraftInvoices(userId);
    return result.length;
  }

  public async getDraftInvoices(userId?: string) : Promise<any> {
    let params;
    if (userId) {
      params = { Status: BillingInvoiceStatus.DRAFT, UserID: [this.userContext.id] };
    } else {
      params = { Status: BillingInvoiceStatus.DRAFT };
    }

    const paging = TestConstants.DEFAULT_PAGING;
    const ordering = [{ field: '-createdOn' }];
    const response = await this.adminUserService.billingApi.readInvoices(params, paging, ordering);
    return response?.data?.result;
  }

  public isBillingProperlyConfigured(): boolean {
    const billingSettings = this.getLocalSettings(false);
    // Check that the mandatory settings are properly provided
    return (!!billingSettings.stripe.publicKey
      && !!billingSettings.stripe.secretKey
      && !!billingSettings.stripe.url);
  }

  public async getLatestDraftInvoice(userId?: string): Promise<BillingInvoice> {
    // ACHTUNG: There is no data after running: npm run mochatest:createContext
    // In that situation we return 0!
    const draftInvoices = await this.getDraftInvoices(userId);
    return (draftInvoices && draftInvoices.length > 0) ? draftInvoices[0] : null;
  }

  public async getNumberOfSessions(userId?: string): Promise<number> {
    // ACHTUNG: There is no data after running: npm run mochatest:createContext
    // In that situation we return 0!
    const draftInvoice = await this.getLatestDraftInvoice(userId);
    return (draftInvoice) ? draftInvoice.sessions?.length : 0;
  }

  public async createTariff4ChargingStation(
      testMode: string,
      chargingStation: ChargingStation,
      dimensions: PricingDimensions,
      connectorType: ConnectorType = null,
      restrictions: PricingRestriction = null): Promise<void> {

    // Set a default value
    connectorType = connectorType || ConnectorType.TYPE_2;

    const tariff: Partial<PricingDefinition> = {
      entityID: chargingStation.id, // a pricing model for the site
      entityType: PricingEntity.CHARGING_STATION,
      name: testMode,
      description: 'Tariff for CS ' + chargingStation.id + ' - ' + testMode + ' - ' + connectorType,
      staticRestrictions: {
        connectorType,
        validFrom: new Date(),
        validTo: moment().add(10, 'minutes').toDate()
      },
      restrictions,
      dimensions
    };

    let response = await this.adminUserService.pricingApi.createPricingDefinition(tariff);
    assert(response?.data?.status === 'Success', 'The operation should succeed');
    assert(response?.data?.id, 'The ID should not be null');

    const pricingDefinitionId = response?.data?.id;
    response = await this.adminUserService.pricingApi.readPricingDefinition(pricingDefinitionId);
    assert(response?.data?.id === pricingDefinitionId, 'The ID should be: ' + pricingDefinitionId);
    assert(response?.data?.entityName === chargingStation.id);

    // Create a 2nd one valid in the future with a stupid flat fee
    tariff.name = tariff.name + ' - In the future';
    tariff.staticRestrictions = {
      connectorType,
      validFrom: moment().add(10, 'years').toDate(),
    },
    tariff.dimensions.flatFee = {
      active: true,
      price: 111
    };
    response = await this.adminUserService.pricingApi.createPricingDefinition(tariff);
    assert(response?.data?.status === 'Success', 'The operation should succeed');
    assert(response?.data?.id, 'The ID should not be null');

    // Create a 3rd one valid in the past
    tariff.name = tariff.name + ' - In the past';
    tariff.staticRestrictions = {
      connectorType,
      validTo: moment().add(-1, 'hours').toDate(),
    },
    tariff.dimensions.flatFee = {
      active: true,
      price: 222
    };
    response = await this.adminUserService.pricingApi.createPricingDefinition(tariff);
    assert(response?.data?.status === 'Success', 'The operation should succeed');
    assert(response?.data?.id, 'The ID should not be null');
  }

  public async checkPricingDefinitionEndpoints(): Promise<void> {

    this.siteContext = this.tenantContext.getSiteContext(ContextDefinition.SITE_CONTEXTS.SITE_BASIC);
    this.siteAreaContext = this.siteContext.getSiteAreaContext(ContextDefinition.SITE_AREA_CONTEXTS.WITH_ACL);

    const siteArea = this.siteAreaContext.getSiteArea();

    const parkingPrice: PricingDimension = {
      price: 0.75,
      active: true
    };
    const tariffForSiteArea: Partial<PricingDefinition> = {
      entityID: siteArea?.id, // a pricing model for the tenant
      entityType: PricingEntity.SITE_AREA,
      name: 'Tariff for Site Area: ' + siteArea?.name,
      description : 'Tariff for Site Area: ' + siteArea?.name,
      staticRestrictions: {
        connectorPowerkW: 40,
        validFrom: new Date(),
        validTo: moment().add(10, 'minutes').toDate(),
      },
      dimensions: {
        chargingTime: parkingPrice,
        // energy: price4TheEnergy, // do not bill the energy - bill the parking time instead
        parkingTime: parkingPrice,
      }
    };
    let response = await this.adminUserService.pricingApi.createPricingDefinition(tariffForSiteArea);
    assert(response?.data?.status === 'Success', 'The operation should succeed');
    assert(response?.data?.id, 'The ID should not be null');

    const pricingDefinitionId = response?.data?.id;
    response = await this.adminUserService.pricingApi.readPricingDefinition(pricingDefinitionId);
    assert(response?.data?.id === pricingDefinitionId, 'The ID should be: ' + pricingDefinitionId);
    assert(response?.data?.entityName === siteArea.name, 'The Site Area data should be retrieved as well');
  }
}