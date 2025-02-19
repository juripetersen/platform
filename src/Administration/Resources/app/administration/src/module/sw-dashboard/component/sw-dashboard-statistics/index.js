import template from './sw-dashboard-statistics.html.twig';
import './sw-dashboard-statistics.scss';

const { Component } = Shopware;
const { Criteria } = Shopware.Data;

Component.register('sw-dashboard-statistics', {
    template,

    inject: [
        'repositoryFactory',
        'stateStyleDataProviderService',
        'acl',
    ],

    data() {
        return {
            historyOrderDataCount: null,
            historyOrderDataSum: null,
            todayOrderData: [],
            todayOrderDataLoaded: false,
            todayOrderDataSortBy: 'orderDateTime',
            todayOrderDataSortDirection: 'DESC',
            statisticDateRanges: {
                value: '30Days',
                options: {
                    '30Days': 30,
                    '14Days': 14,
                    '7Days': 7,
                    '24Hours': 24,
                    yesterday: 1,
                },
            },
            isLoading: true,
        };
    },

    computed: {
        chartOptionsOrderCount() {
            return {
                title: {
                    text: this.$tc('sw-dashboard.monthStats.orderNumber'),
                    style: {
                        fontSize: '16px',
                        fontWeight: '600',
                    },
                },
                xaxis: {
                    type: 'datetime',
                    min: this.dateAgo.getTime(),
                    labels: {
                        datetimeUTC: false,
                    },
                },
                yaxis: {
                    min: 0,
                    tickAmount: 3,
                    labels: {
                        formatter: (value) => { return parseInt(value, 10); },
                    },
                },
            };
        },

        chartOptionsOrderSum() {
            return {
                title: {
                    text: this.$tc('sw-dashboard.monthStats.turnover'),
                    style: {
                        fontSize: '16px',
                        fontWeight: '600',
                    },
                },
                xaxis: {
                    type: 'datetime',
                    min: this.dateAgo.getTime(),
                    labels: {
                        datetimeUTC: false,
                    },
                },
                yaxis: {
                    min: 0,
                    tickAmount: 5,
                    labels: {
                        // price aggregations do not support currencies yet, see NEXT-5069
                        formatter: (value) => this.$options.filters.currency(value, null, 2),
                    },
                },
            };
        },

        orderRepository() {
            return this.repositoryFactory.create('order');
        },

        orderCountMonthSeries() {
            return this.orderCountSeries;
        },

        orderCountSeries() {
            if (!this.historyOrderDataCount) {
                return [];
            }

            // format data for chart
            const seriesData = this.historyOrderDataCount.buckets.map((data) => {
                return { x: this.parseDate(data.key), y: data.count };
            });

            // add empty value for today if there isn't any order, otherwise today would be missing
            if (!this.todayBucket) {
                seriesData.push({ x: this.today.getTime(), y: 0 });
            }

            return [{ name: this.$tc('sw-dashboard.monthStats.numberOfOrders'), data: seriesData }];
        },

        orderCountToday() {
            if (this.todayBucket) {
                return this.todayBucket.count;
            }
            return 0;
        },

        orderSumMonthSeries() {
            return this.orderSumSeries;
        },

        orderSumSeries() {
            if (!this.historyOrderDataSum) {
                return [];
            }

            // format data for chart
            const seriesData = this.historyOrderDataSum.buckets.map((data) => {
                return { x: this.parseDate(data.key), y: data.totalAmount.sum };
            });

            // add empty value for today if there isn't any order, otherwise today would be missing
            if (!this.todayBucket) {
                seriesData.push({ x: this.today.getTime(), y: 0 });
            }

            return [{ name: this.$tc('sw-dashboard.monthStats.totalTurnover'), data: seriesData }];
        },

        orderSumToday() {
            if (this.todayBucket) {
                return this.todayBucket.totalAmount.sum;
            }
            return 0;
        },

        hasOrderToday() {
            return this.todayOrderData.length > 0;
        },

        hasOrderInMonth() {
            return !!this.historyOrderDataCount && !!this.historyOrderDataSum;
        },

        dateAgo() {
            const date = new Date();
            const selectedDateRange = this.statisticDateRanges.value;
            const dateRange = this.statisticDateRanges.options[selectedDateRange] ?? 0;

            // special case for "24Hours": return directly because we need hours instead of days
            if (selectedDateRange === '24Hours') {
                date.setHours(date.getHours() - dateRange);

                return date;
            }

            date.setDate(date.getDate() - dateRange);
            date.setHours(0, 0, 0, 0);

            return date;
        },

        today() {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            return today;
        },

        todayBucket() {
            if (!(this.historyOrderDataCount && this.historyOrderDataSum)) {
                return null;
            }

            const todayStart = new Date().setHours(0, 0, 0, 0);
            const todayEnd = new Date().setHours(23, 59, 59, 999);
            // search for stats with same timestamp as today
            const findDateStatsCount = this.historyOrderDataCount.buckets.find((dateCount) => {
                // when date exists
                if (dateCount.key) {
                    const timeConverted = this.parseDate(dateCount.key);

                    // if time is today
                    return timeConverted >= todayStart && timeConverted <= todayEnd;
                }

                return false;
            });

            if (findDateStatsCount) {
                return findDateStatsCount;
            }
            return null;
        },

        getTimeUnitInterval() {
            const statisticDateRange = this.statisticDateRanges.value;

            if (statisticDateRange === 'yesterday' || statisticDateRange === '24Hours') {
                return 'hour';
            }

            return 'day';
        },

        systemCurrencyISOCode() {
            return Shopware.Context.app.systemCurrencyISOCode;
        },

        isSessionLoaded() {
            return !Shopware.State.get('session')?.userPending;
        },
    },

    watch: {
        isSessionLoaded: {
            immediate: true,
            handler() {
                if (this.isSessionLoaded) {
                    this.initializeOrderData();
                }
            },
        },
    },

    methods: {
        async initializeOrderData() {
            if (!this.acl.can('order.viewer')) {
                this.isLoading = false;

                return;
            }

            this.todayOrderDataLoaded = false;

            await this.getHistoryOrderData();
            this.todayOrderData = await this.fetchTodayData();
            this.todayOrderDataLoaded = true;
            this.isLoading = false;
        },

        getHistoryOrderData() {
            return Promise.all([
                this.fetchHistoryOrderDataCount().then((response) => {
                    if (response.aggregations) {
                        this.historyOrderDataCount = response.aggregations.order_count_bucket;
                    }
                }),
                this.fetchHistoryOrderDataSum().then((response) => {
                    if (response.aggregations) {
                        this.historyOrderDataSum = response.aggregations.order_sum_bucket;
                    }
                }),
            ]);
        },

        fetchHistoryOrderDataCount() {
            const criteria = new Criteria(1, 1);

            criteria.addAggregation(
                Criteria.histogram(
                    'order_count_bucket',
                    'orderDateTime',
                    this.getTimeUnitInterval,
                    null,
                    Criteria.sum('totalAmount', 'amountTotal'),
                    Shopware.State.get('session').currentUser?.timeZone ?? 'UTC',
                ),
            );

            criteria.addFilter(Criteria.range('orderDate', { gte: this.formatDate(this.dateAgo) }));

            return this.orderRepository.search(criteria);
        },

        fetchHistoryOrderDataSum() {
            const criteria = new Criteria(1, 1);

            criteria.addAggregation(
                Criteria.histogram(
                    'order_sum_bucket',
                    'orderDateTime',
                    this.getTimeUnitInterval,
                    null,
                    Criteria.sum('totalAmount', 'amountTotal'),
                    Shopware.State.get('session').currentUser?.timeZone ?? 'UTC',
                ),
            );

            criteria.addAssociation('stateMachineState');

            criteria.addFilter(Criteria.equals('transactions.stateMachineState.technicalName', 'paid'));
            criteria.addFilter(Criteria.range('orderDate', { gte: this.formatDate(this.dateAgo) }));

            return this.orderRepository.search(criteria);
        },

        fetchTodayData() {
            const criteria = new Criteria(1, 10);

            criteria.addAssociation('currency');

            criteria.addFilter(Criteria.equals('orderDate', this.formatDate(new Date())));
            criteria.addSorting(Criteria.sort(this.todayOrderDataSortBy, this.todayOrderDataSortDirection));

            return this.orderRepository.search(criteria);
        },

        formatDate(date) {
            return Shopware.Utils.format.toISODate(date, false);
        },

        orderGridColumns() {
            return [{
                property: 'orderNumber',
                label: 'sw-order.list.columnOrderNumber',
                routerLink: 'sw.order.detail',
                allowResize: true,
                primary: true,
            }, {
                property: 'orderDateTime',
                dataIndex: 'orderDateTime',
                label: 'sw-dashboard.todayStats.orderTime',
                allowResize: true,
                primary: false,
            }, {
                property: 'orderCustomer.firstName',
                dataIndex: 'orderCustomer.firstName,orderCustomer.lastName',
                label: 'sw-order.list.columnCustomerName',
                allowResize: true,
            }, {
                property: 'stateMachineState.name',
                label: 'sw-order.list.columnState',
                allowResize: true,
            }, {
                property: 'amountTotal',
                label: 'sw-order.list.columnAmount',
                align: 'right',
                allowResize: true,
            }];
        },

        getVariantFromOrderState(order) {
            return this.stateStyleDataProviderService.getStyle('order.state', order.stateMachineState.technicalName).variant;
        },

        parseDate(date) {
            const parsedDate = new Date(date.replace(/-/g, '/').replace('T', ' ').replace(/\..*|\+.*/, ''));
            return parsedDate.valueOf();
        },
    },
});
