import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Armchair, ArrowDownRight, ArrowLeft, ArrowUpRight, CalendarClock, Check, ChevronDown, Coffee, GitMerge,
  Ban, CopyPlus, CreditCard, Flame, History, Minus, Plus, Printer, Search, ShieldCheck, ShoppingBag,
  Soup, Sparkles, Trash2, Truck, Users, UtensilsCrossed, Wallet, LogOut, Keyboard,
} from 'lucide-react'
import type {
  BillHistoryEntry,
  CreateOrderInput,
  MenuData,
  OrderType,
  PaymentMethod,
  PaymentRecord,
  Product,
  RecordPaymentInput,
  RestaurantTable,
  SavedOrder,
  DeliveryCustomerRecord,
  StaffAccessState,
  StaffIdentity,
} from '../../shared/domain'
import type { CashSummary } from '../../shared/restaurant'
import { DELIVERY_SLOT_COUNT, PARCEL_SLOT_COUNT, formatOrderReference } from '../../shared/domain'
import { staffHasPermission } from '../../shared/staffPermissions'
import { RestaurantTableCard } from '../components/RestaurantTableCard'
import { calculateTotals, formatMoney, InvoicePreview, JoinBillDialog, RecallBillDialog, SplitBillDialog, parseDiscountInput, type DiscountMode } from '../features/billing'
import { BillHistoryDialog } from '../features/payments'
import { SavedBillsDialog } from '../features/payments/SavedBillsDialog'
import { assignDeliveryRiderBatch, authorizeManagement, cashOutDelivery, createOrder, getCashSummary, getOrder, getPaymentLedger, getStaffAccessState, joinOrders, listBillHistory, loadMenu, logoutStaff, managerPinConfigured, openCash, recordDuplicateKotRequest, recordPayment, resetManagerPin, setManagerPin, splitOrder, updateDeliverySchedule, voidOrder, voidOrderItem } from '../services/pos'
import { ManagerActionDialog } from '../features/security/ManagerActionDialog'
import { ManagementPinDialog } from '../features/security/ManagementPinDialog'
import { ItemVoidDialog } from '../features/security/ItemVoidDialog'
import { KitchenTicketPreview } from '../features/kitchen/KitchenTicketPreview'
import { DeliveryActionDialog } from '../features/delivery/DeliveryActionDialog'
import { DeliveryCashOutDialog } from '../features/delivery/DeliveryCashOutDialog'
import { DeliveryCustomerDialog, type DeliveryCustomerDetails } from '../features/delivery/DeliveryCustomerDialog'
import { ParcelCustomerDialog } from '../features/delivery/ParcelCustomerDialog'
import { StaffAccessScreen } from '../features/staff/StaffAccessScreen'
import { StaffManagementDialog } from '../features/staff/StaffManagementDialog'
import { DesktopPrinters } from '../features/printing/DesktopPrinters'
import { TablePrintDialog } from '../features/printing/TablePrintDialog'
import '../features/printing/printing.css'
import { RestaurantManagement } from '../features/management/RestaurantManagement'
import { CashOpeningDialog } from '../features/management/CashOpeningDialog'
import { PaymentLedgerDialog } from '../features/management/PaymentLedgerDialog'
import { WaiterScreen } from '../features/management/WaiterScreen'
import { DeliveryScheduleScreen } from '../features/delivery/DeliveryScheduleScreen'
import type { CartLine } from '../types/cart'
import { elapsedClockLabel, tableOrderTimer } from '../utils/tablePresentation'
import '../styles/cashier.css'
import billmitraLogo from '../assets/billmitra-red-symbol.svg'
import { OrderShortcutsDialog } from '../features/shortcuts/OrderShortcutsDialog'
import { loadOrderShortcuts, shortcutFromEvent } from '../features/shortcuts/orderShortcuts'
import { cardShortcutFromEvent, loadCardShortcuts } from '../features/shortcuts/cardShortcuts'

type ServiceSection = 'tables' | 'parcel' | 'delivery'
type ManagerDialogMode = 'setup' | 'void'

const categoryIcons: Record<string, typeof Soup> = {
  starters: Sparkles,
  mains: Soup,
  breads: Flame,
  drinks: Coffee,
  desserts: Sparkles,
}

function deliveryCashOutBlockReason(order: SavedOrder): string | null {
  if (order.deliveryStatus === 'failed') return 'This delivery failed. Reassign it in Delivery schedule before taking payment.'
  if (order.deliveryStatus === 'cancelled') return 'This delivery was cancelled and cannot be cashed out. Review it in Delivery schedule.'
  return null
}

function CashierPage({ branchName = 'Restaurant', onChangeBranch }: { branchName?: string; onChangeBranch?: () => void } = {}) {
  const branchControlMode = new URLSearchParams(window.location.search).get('mode') === 'branch-control'
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try { return window.localStorage.getItem('billmitra-appearance') === 'dark' ? 'dark' : 'light' } catch { return 'light' }
  })
  useEffect(() => {
    document.documentElement.classList.toggle('billmitra-dark-mode', theme === 'dark')
    try { window.localStorage.setItem('billmitra-appearance', theme) } catch { /* Appearance still applies for this session. */ }
    return () => document.documentElement.classList.remove('billmitra-dark-mode')
  }, [theme])
  const [staffAccess, setStaffAccess] = useState<StaffAccessState | null>(null)
  const [menu, setMenu] = useState<MenuData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [serviceSection, setServiceSection] = useState<ServiceSection>('tables')
  const [orderType, setOrderType] = useState<OrderType>('dine_in')
  const [floor, setFloor] = useState('All tables')
  const [tableViewOpen, setTableViewOpen] = useState(false)
  const [deliveryOrderOpen, setDeliveryOrderOpen] = useState(false)
  const [parcelOrderOpen, setParcelOrderOpen] = useState(false)
  const [selectedDeliveryNumber, setSelectedDeliveryNumber] = useState<number | null>(null)
  const [selectedParcelNumber, setSelectedParcelNumber] = useState<number | null>(null)
  const [scheduledDeliveryAt, setScheduledDeliveryAt] = useState<string | null>(null)
  const [assignedDeliveryTo, setAssignedDeliveryTo] = useState('')
  const [showDeliveryScheduleDialog, setShowDeliveryScheduleDialog] = useState(false)
  const [selectedTable, setSelectedTable] = useState<string | null>(null)
  const [activeOrder, setActiveOrder] = useState<SavedOrder | null>(null)
  const [previewOrder, setPreviewOrder] = useState<SavedOrder | null>(null)
  const [cashSummary, setCashSummary] = useState<CashSummary | null>(null)
  const [deliveryCashOut, setDeliveryCashOut] = useState<{ order: SavedOrder; balancePaise: number; requestId: string } | null>(null)
  const [lastPayment, setLastPayment] = useState<PaymentRecord | null>(null)
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash')
  const [paymentSubmitting, setPaymentSubmitting] = useState(false)
  const [cashChecking, setCashChecking] = useState(false)
  const cashActionInProgress = useRef(false)
  const [failedPayment, setFailedPayment] = useState<RecordPaymentInput | null>(null)
  const [billHistory, setBillHistory] = useState<BillHistoryEntry[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [showHistory, setShowHistory] = useState(false)
  const [showSavedBills, setShowSavedBills] = useState(false)
  const closeSavedBills = useCallback(() => setShowSavedBills(false), [])
  const [showStaffManagement, setShowStaffManagement] = useState(false)
  const [showManagement, setShowManagement] = useState(false)
  const [showManagementPin, setShowManagementPin] = useState(false)
  const [managementSetupRequested, setManagementSetupRequested] = useState(false)
  const [showPaymentLedger, setShowPaymentLedger] = useState(false)
  const [showWaiter, setShowWaiter] = useState(false)
  const [showDeliverySchedule, setShowDeliverySchedule] = useState(false)
  const [deliveryBoardAssignment, setDeliveryBoardAssignment] = useState<{ riderId: string; riderName: string; orderIds: string[] } | null>(null)
  const [deliveryBoardAssignmentBusy, setDeliveryBoardAssignmentBusy] = useState(false)
  const [hasManagerPin, setHasManagerPin] = useState(false)
  const [managerDialogMode, setManagerDialogMode] = useState<ManagerDialogMode | null>(null)
  const [showItemVoid, setShowItemVoid] = useState(false)
  const [showSplitBill, setShowSplitBill] = useState(false)
  const [showJoinBill, setShowJoinBill] = useState(false)
  const [showRecallBill, setShowRecallBill] = useState(false)
  const [categoryId, setCategoryId] = useState('all')
  const [search, setSearch] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchSelection, setSearchSelection] = useState(0)
  const [showKitchenMessage, setShowKitchenMessage] = useState(false)
  const [kitchenMessage, setKitchenMessage] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)
  const searchResultsRef = useRef<HTMLDivElement>(null)
  const [cart, setCart] = useState<CartLine[]>([])
  const [selectedDraftProductId, setSelectedDraftProductId] = useState<string | null>(null)
  const [orderShortcuts, setOrderShortcuts] = useState(loadOrderShortcuts)
  const [cardShortcuts, setCardShortcuts] = useState(loadCardShortcuts)
  const [showOrderShortcuts, setShowOrderShortcuts] = useState(false)
  const [discountMode, setDiscountMode] = useState<DiscountMode>('none')
  const [discountInput, setDiscountInput] = useState('0')
  const [showInvoice, setShowInvoice] = useState(false)
  const [showKitchenTicket, setShowKitchenTicket] = useState(false)
  const [tablePrint, setTablePrint] = useState<{ table: RestaurantTable; kind: 'bill' | 'kot' } | null>(null)
  const closeTablePrint = useCallback(() => setTablePrint(null), [])
  const [kitchenTicketDuplicate, setKitchenTicketDuplicate] = useState(false)
  const [showDeliveryCustomerDialog, setShowDeliveryCustomerDialog] = useState(false)
  const [showParcelCustomerDialog, setShowParcelCustomerDialog] = useState(false)
  const [deliveryCustomerStaged, setDeliveryCustomerStaged] = useState(false)
  const [deliveryWhatsappOptIn, setDeliveryWhatsappOptIn] = useState(false)
  const [customerName, setCustomerName] = useState('')
  const [contactNumber, setContactNumber] = useState('')
  const [deliveryAddress, setDeliveryAddress] = useState('')
  const [deliveryArea, setDeliveryArea] = useState('')
  const [deliveryLandmark, setDeliveryLandmark] = useState('')
  const [deliveryInstructions, setDeliveryInstructions] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [failedSubmission, setFailedSubmission] = useState<CreateOrderInput | null>(null)
  const [savedMessage, setSavedMessage] = useState('')
  const [clock, setClock] = useState(() => new Date())
  const [liveError, setLiveError] = useState('')
  const [deliveryTimerNow, setDeliveryTimerNow] = useState(() => Date.now())
  const [deliveryCardSearch, setDeliveryCardSearch] = useState('')
  const [parcelCardSearch, setParcelCardSearch] = useState('')
  const staff = staffAccess?.staff ?? null
  const connected = !window.pos || window.pos.connectionMode === 'connected'
  const canApplyDiscount = Boolean(staff && staffHasPermission(staff.role, 'discount:apply'))
  const canManageStaff = Boolean(staff && staffHasPermission(staff.role, 'staff:manage'))
  const canManageSettings = Boolean(staff && staffHasPermission(staff.role, 'settings:manage'))
  const canVoidBills = Boolean(staff && staffHasPermission(staff.role, 'bill:void'))
  const canViewDeliveries = Boolean(staff && staffHasPermission(staff.role, 'delivery:view'))
  const canManageDeliveryRiders = Boolean(staff && staffHasPermission(staff.role, 'delivery:riders'))
  const canReassignDeliveries = Boolean(staff && staffHasPermission(staff.role, 'delivery:reassign'))

  async function refreshMenu(): Promise<MenuData> {
    const data = await loadMenu()
    setMenu(data)
    return data
  }

  useEffect(() => {
    let mounted = true
    getStaffAccessState()
      .then((access) => {
        if (!mounted) return
        setStaffAccess(access)
        if (!access.staff || !staffHasPermission(access.staff.role, 'pos:access')) setLoading(false)
      })
      .catch((reason: unknown) => {
        if (mounted) {
          setError(reason instanceof Error ? reason.message : 'Unable to check staff access.')
          setLoading(false)
        }
      })
    const timer = window.setInterval(() => setClock(new Date()), 60_000)
    return () => {
      mounted = false
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    if (!staff || !staffHasPermission(staff.role, 'pos:access')) return
    let mounted = true
    Promise.all([
      loadMenu(),
      staffHasPermission(staff.role, 'bill:void') ? managerPinConfigured() : Promise.resolve(false),
    ])
      .then(([data, hasPin]) => {
        if (!mounted) return
        setMenu(data)
        setHasManagerPin(hasPin)
        setError('')
      })
      .catch((reason: unknown) => {
        if (mounted) setError(reason instanceof Error ? reason.message : 'Unable to load the local menu.')
      })
      .finally(() => { if (mounted) setLoading(false) })
    return () => { mounted = false }
  }, [staff])

  useEffect(() => {
    if (!staff || !staffHasPermission(staff.role, 'payments:record')) return
    let active = true
    const refresh = () => { void getCashSummary().then(summary => {
      if (active) setCashSummary(summary)
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : 'Unable to check the cash drawer.') }) }
    refresh()
    const timer = window.setInterval(refresh, 15_000)
    return () => { active = false; window.clearInterval(timer); setCashSummary(null) }
  }, [staff])

  async function handleOpenCash(requestId: string, openingPaise: number): Promise<void> {
    await openCash({ requestId, openingPaise })
    setCashSummary(await getCashSummary())
    setSavedMessage(`Cash drawer opened with ${formatMoney(openingPaise)}.`)
  }

  useEffect(() => {
    if (!connected || !staff || !staffHasPermission(staff.role, 'pos:access')) return
    let active = true
    let inFlight = false
    const refresh = async () => {
      if (inFlight || document.visibilityState === 'hidden') return
      inFlight = true
      try {
        const data = await loadMenu()
        if (active) { setMenu(data); setLiveError('') }
      } catch (cause) {
        if (active) setLiveError(cause instanceof Error ? cause.message : 'Restaurant connection lost.')
        if (active && cause instanceof Error && cause.message.includes('Sign in with a staff account')) {
          try {
            const access = await getStaffAccessState()
            if (active && !access.staff) {
              setStaffAccess(access)
              setMenu(null)
              setLiveError('')
            }
          } catch { /* Keep the current screen until the server responds. */ }
        }
      } finally { inFlight = false }
    }
    const timer = window.setInterval(() => void refresh(), 5000)
    window.addEventListener('focus', refresh)
    return () => { active = false; window.clearInterval(timer); window.removeEventListener('focus', refresh) }
  }, [connected, staff])

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && document.activeElement === searchInputRef.current) {
        setSearch(''); setSearchOpen(false); searchInputRef.current?.blur()
      }
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [])

  useEffect(() => {
    if (!staff) return
    if ((serviceSection !== 'delivery' || deliveryOrderOpen) && (serviceSection !== 'tables' || tableViewOpen) && (serviceSection !== 'parcel' || parcelOrderOpen)) return
    const tick = () => setDeliveryTimerNow(Date.now())
    const timer = window.setInterval(tick, 1000)
    window.addEventListener('focus', tick)
    document.addEventListener('visibilitychange', tick)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', tick); document.removeEventListener('visibilitychange', tick) }
  }, [deliveryOrderOpen, parcelOrderOpen, serviceSection, tableViewOpen, staff])

  const floors = useMemo(() => [...new Set(menu?.tables.map((table) => table.floor) ?? [])], [menu])
  const visibleProducts = useMemo(() => {
    return (menu?.products ?? []).filter((product) => (
      product.available
      && (categoryId === 'all' || product.categoryId === categoryId)
    ))
  }, [categoryId, menu])
  const searchResults = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    if (!query) return visibleProducts.slice(0, 7)
    return (menu?.products ?? [])
      .filter((product) => product.available
        && `${product.name} ${product.description} ${product.categoryId}`.toLocaleLowerCase().includes(query))
      .slice(0, 7)
  }, [menu, search, visibleProducts])
  useEffect(() => {
    if (!searchOpen) return
    setSearchSelection(current => Math.min(current, Math.max(0, searchResults.length - 1)))
  }, [searchOpen, searchResults.length])
  useEffect(() => {
    if (!searchOpen) return
    searchResultsRef.current?.querySelectorAll<HTMLElement>('[role="option"]')[searchSelection]?.scrollIntoView({ block: 'nearest' })
  }, [searchOpen, searchSelection])
  const visibleTables = (menu?.tables ?? []).filter((table) => floor === 'All tables' || table.floor === floor)
  const selectedTableOrders = useMemo(() => selectedTable
    ? (menu?.activeOrders ?? []).filter((order) => order.type === 'dine_in' && order.tableId === selectedTable && !order.savedAt)
    : [], [menu, selectedTable])
  const joinableBills = useMemo(() => (menu?.activeOrders ?? []).filter(order => order.type === 'dine_in' && !order.savedAt && order.status !== 'paid' && order.status !== 'voided' && order.status !== 'joined'), [menu])
  const recallableBills = useMemo(() => (menu?.activeOrders ?? []).filter(order => !order.savedAt), [menu])
  const savedBills = (menu?.activeOrders ?? []).filter(order => Boolean(order.savedAt))
  const printTargetForOrder = (order: SavedOrder): RestaurantTable => {
    if (order.type === 'dine_in' && order.tableId) {
      const original = menu?.tables.find(table => table.id === order.tableId)
      if (original) return { ...original, name: order.savedTableName ?? original.name, floor: order.savedTableFloor ?? original.floor, orderId: order.id }
    }
    const status = ['ordering', 'preparing', 'ready', 'payment_pending'].includes(order.status)
      ? order.status as RestaurantTable['status']
      : 'payment_pending'
    return {
      id: order.id,
      name: formatOrderReference(order),
      floor: order.type === 'delivery' ? 'Home delivery' : 'Takeaway',
      capacity: 0,
      status,
      orderId: order.id,
      orderNumber: order.orderNumber,
      amountPaise: order.totalPaise,
      startedAt: order.createdAt,
      activeOrderCount: 1,
    }
  }
  const printableTable = activeOrder ? printTargetForOrder(activeOrder) : null
  const activeDeliveryOrders = (menu?.activeOrders ?? []).filter((order) => order.type === 'delivery')
  const deliverySlots = Array.from({ length: menu?.cardSettings?.deliveryCount ?? DELIVERY_SLOT_COUNT }, (_, index) => {
    const deliveryNumber = index + 1
    return {
      deliveryNumber,
      order: activeDeliveryOrders.find((order) => order.deliveryNumber === deliveryNumber) ?? null,
    }
  })
  const occupiedDeliverySlots = activeDeliveryOrders.filter((order) => order.deliveryNumber !== null).length
  const visibleDeliverySlots = useMemo(() => {
    const query = deliveryCardSearch.trim().toLocaleLowerCase()
    if (!query) return deliverySlots
    return deliverySlots.filter(({ deliveryNumber, order }) => Boolean(order && [
      `hd-${deliveryNumber}`,
      String(deliveryNumber),
      order.customerName,
      order.contactNumber,
      order.deliveryArea,
      order.deliveryLandmark,
      order.deliveryAddress,
    ].join(' ').toLocaleLowerCase().includes(query)))
  }, [deliveryCardSearch, deliverySlots])
  const activeParcelOrders = (menu?.activeOrders ?? []).filter((order) => order.type === 'parcel')
  const parcelSlots = Array.from({ length: menu?.cardSettings?.parcelCount ?? PARCEL_SLOT_COUNT }, (_, index) => {
    const parcelNumber = index + 1
    return {
      parcelNumber,
      order: activeParcelOrders.find((order) => order.parcelNumber === parcelNumber) ?? null,
    }
  })
  const occupiedParcelSlots = activeParcelOrders.filter((order) => order.parcelNumber !== null).length
  const visibleParcelSlots = useMemo(() => {
    const query = parcelCardSearch.trim().toLocaleLowerCase()
    if (!query) return parcelSlots
    return parcelSlots.filter(({ parcelNumber, order }) => Boolean(order && [
      `p-${parcelNumber}`,
      String(parcelNumber),
      order.customerName,
      order.contactNumber,
      order.deliveryArea,
    ].join(' ').toLocaleLowerCase().includes(query)))
  }, [parcelCardSearch, parcelSlots])
  const existingLines = activeOrder?.items ?? []
  const invoiceLines = [
    ...existingLines.map((item) => ({
    unitPricePaise: item.unitPricePaise,
    quantity: item.quantity,
    taxRateBps: item.taxRateBps,
    })),
    ...cart.map(({ product, quantity }) => ({
    unitPricePaise: product.pricePaise,
    quantity,
    taxRateBps: product.taxRateBps,
    })),
  ]
  const beforeDiscount = calculateTotals(invoiceLines)
  const parsedDiscount = parseDiscountInput(discountMode, discountInput, beforeDiscount.subtotalPaise)
  const invoiceTotals = calculateTotals(invoiceLines, parsedDiscount.error ? null : parsedDiscount.discount)
  const subtotalPaise = invoiceTotals.subtotalPaise
  const discountPaise = invoiceTotals.discountPaise
  const taxPaise = invoiceTotals.taxPaise
  const totalPaise = invoiceTotals.totalPaise
  const discountChanged = activeOrder !== null
    && JSON.stringify(parsedDiscount.discount) !== JSON.stringify(activeOrder.discount)
  const kitchenMessageChanged = activeOrder !== null && kitchenMessage.trim() !== (activeOrder.kitchenMessage ?? '')
  const deliveryDetailsChanged = activeOrder?.type === 'delivery'
    && (customerName.trim() !== activeOrder.customerName
      || contactNumber.trim() !== activeOrder.contactNumber
      || deliveryAddress.trim() !== activeOrder.deliveryAddress
      || deliveryArea.trim() !== activeOrder.deliveryArea
      || deliveryLandmark.trim() !== activeOrder.deliveryLandmark
      || deliveryInstructions.trim() !== activeOrder.deliveryInstructions)
  const deliveryBillHasUnsavedChanges = Boolean(activeOrder && (
    cart.length > 0
    || discountChanged
    || customerName.trim() !== activeOrder.customerName
    || contactNumber.trim() !== activeOrder.contactNumber
    || deliveryAddress.trim() !== activeOrder.deliveryAddress
    || deliveryArea.trim() !== activeOrder.deliveryArea
    || deliveryLandmark.trim() !== activeOrder.deliveryLandmark
    || deliveryInstructions.trim() !== activeOrder.deliveryInstructions
  ))
  const canEditDeliveryMetadata = selectedDeliveryNumber !== null
    && activeOrder?.type === 'delivery'
    && activeOrder.status !== 'voided'
    && !deliveryBillHasUnsavedChanges
    && !submitting
    && !failedSubmission
  const canSaveInvoice = !submitting && !failedSubmission && !parsedDiscount.error
    && !activeOrder?.savedAt
    && activeOrder?.status !== 'paid' && activeOrder?.status !== 'voided'
    && (cart.length > 0 || discountChanged || deliveryDetailsChanged || deliveryCustomerStaged || kitchenMessageChanged)
    && (!discountChanged || canApplyDiscount)
    && (orderType !== 'dine_in' || Boolean(selectedTable))
    && (orderType !== 'parcel' || selectedParcelNumber !== null)
    && (orderType !== 'delivery' || selectedDeliveryNumber !== null)
  const canClearDraft = !submitting && !failedSubmission && activeOrder?.status !== 'paid' && activeOrder?.status !== 'voided'
    && (cart.length > 0 || discountChanged || deliveryDetailsChanged || kitchenMessageChanged || (!activeOrder && Boolean(kitchenMessage.trim() || customerName.trim() || contactNumber.trim() || deliveryAddress.trim() || scheduledDeliveryAt || assignedDeliveryTo)))
  const canVoidBill = Boolean(activeOrder && activeOrder.status !== 'paid' && activeOrder.status !== 'voided'
    && canVoidBills && hasManagerPin && cart.length === 0 && !discountChanged && !deliveryDetailsChanged && !submitting && !failedSubmission)
  const canVoidItem = Boolean(canVoidBill && activeOrder && activeOrder.items.length > 0)
  const canSplitBill = Boolean(activeOrder && activeOrder.type === 'dine_in' && !activeOrder.savedAt
    && activeOrder.status !== 'paid' && activeOrder.status !== 'voided' && activeOrder.items.reduce((total, item) => total + item.quantity, 0) > 1
    && cart.length === 0 && !discountChanged && !submitting && !failedSubmission)
  const canJoinBill = Boolean(staff && staffHasPermission(staff.role, 'orders:write') && cart.length === 0 && !discountChanged && !deliveryDetailsChanged && !kitchenMessageChanged && !submitting && !failedSubmission
    && (!(tableViewOpen || deliveryOrderOpen || parcelOrderOpen) || (tableViewOpen && activeOrder?.type === 'dine_in' && !activeOrder.savedAt)))
  const canCashClose = Boolean(activeOrder && (activeOrder.type === 'dine_in' || activeOrder.type === 'parcel')
    && activeOrder.status !== 'paid' && activeOrder.status !== 'voided'
    && staff && staffHasPermission(staff.role, 'payments:record')
    && cart.length === 0 && !discountChanged && !submitting && !failedSubmission
    && !paymentSubmitting && !cashChecking
    && (!failedPayment || (failedPayment.orderId === activeOrder.id && failedPayment.method === 'cash')))
  const orderEditorOpen = tableViewOpen || deliveryOrderOpen || parcelOrderOpen
  useEffect(() => {
    if (!orderEditorOpen || previewOrder || showDeliveryCustomerDialog || showParcelCustomerDialog
      || activeOrder?.savedAt || activeOrder?.status === 'paid' || activeOrder?.status === 'voided') return
    const frame = window.requestAnimationFrame(() => searchInputRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [orderEditorOpen, selectedTable, selectedDeliveryNumber, selectedParcelNumber,
    previewOrder, showDeliveryCustomerDialog, showParcelCustomerDialog, activeOrder?.savedAt, activeOrder?.status])
  const itemCount = existingLines.reduce((count, item) => count + item.quantity, 0)
    + cart.reduce((count, item) => count + item.quantity, 0)

  function setService(section: ServiceSection): void {
    setServiceSection(section)
    setOrderType(section === 'tables' ? 'dine_in' : section === 'parcel' ? 'parcel' : 'delivery')
    setSelectedTable(null)
    setTableViewOpen(false)
    setDeliveryOrderOpen(false)
    setParcelOrderOpen(false)
    setSelectedDeliveryNumber(null)
    setSelectedParcelNumber(null)
    setScheduledDeliveryAt(null)
    setAssignedDeliveryTo('')
    setShowDeliveryScheduleDialog(false)
    setShowDeliveryCustomerDialog(false)
    setDeliveryCustomerStaged(false)
    setDeliveryWhatsappOptIn(false)
    setPreviewOrder(null)
    setActiveOrder(null)
    setLastPayment(null)
    setCart([])
    setKitchenMessage('')
    setShowKitchenMessage(false)
    setDiscountMode('none')
    setDiscountInput('0')
    setFailedSubmission(null)
    setError('')
    setSavedMessage('')
    if (section !== 'tables') setCustomerName('')
    setContactNumber('')
    setDeliveryAddress('')
  }

  function chooseTable(table: RestaurantTable, edit = false): void {
    if (failedSubmission || submitting) return
    setSearch('')
    setSearchOpen(false)
    setSearchSelection(0)
    setDeliveryCustomerStaged(false)
    const order = (menu?.activeOrders ?? []).find((candidate) => candidate.id === table.orderId)
      ?? (menu?.activeOrders ?? []).find((candidate) => candidate.type === 'dine_in' && candidate.tableId === table.id)
      ?? null
    setSelectedTable(table.id)
    setFloor(table.floor)
    setTableViewOpen(!order || edit)
    setDeliveryOrderOpen(false)
    setParcelOrderOpen(false)
    setSelectedDeliveryNumber(null)
    setSelectedParcelNumber(null)
    setScheduledDeliveryAt(null)
    setAssignedDeliveryTo('')
    setServiceSection('tables')
    setOrderType('dine_in')
    setCart([])
    setError('')
    setSavedMessage('')
    setPreviewOrder(order && !edit ? order : null)
    setActiveOrder(order)
    setKitchenMessage(order?.kitchenMessage ?? '')
    setShowKitchenMessage(false)
    setLastPayment(null)
    if (order?.discount?.kind === 'percentage') {
      setDiscountMode('percentage')
      setDiscountInput(String(order.discount.valueBps / 100))
    } else if (order?.discount?.kind === 'fixed') {
      setDiscountMode('fixed')
      setDiscountInput((order.discount.valuePaise / 100).toFixed(2))
    } else {
      setDiscountMode('none')
      setDiscountInput('0')
    }
    setCustomerName('')
  }

  function chooseTableOrder(order: SavedOrder): void {
    if (failedSubmission || submitting) return
    if (cart.length > 0 && !window.confirm('Discard unsaved items and open this bill?')) return
    setActiveOrder(order)
    setKitchenMessage(order.kitchenMessage ?? '')
    setShowKitchenMessage(false)
    setCart([])
    setLastPayment(null)
    setError('')
    setSavedMessage(`Opened bill #${order.orderNumber}.`)
    if (order.discount?.kind === 'percentage') {
      setDiscountMode('percentage')
      setDiscountInput(String(order.discount.valueBps / 100))
    } else if (order.discount?.kind === 'fixed') {
      setDiscountMode('fixed')
      setDiscountInput((order.discount.valuePaise / 100).toFixed(2))
    } else {
      setDiscountMode('none')
      setDiscountInput('0')
    }
  }

  function recallBill(order: SavedOrder): void {
    if (cart.length > 0 && !window.confirm('Discard unsaved items and recall this bill?')) return
    if (order.type === 'delivery' && order.deliveryNumber !== null) {
      chooseDeliverySlot(order.deliveryNumber, true)
      setShowRecallBill(false)
      return
    }
    if (order.type === 'parcel' && order.parcelNumber !== null) {
      chooseParcelSlot(order.parcelNumber, true)
      setShowRecallBill(false)
      return
    }
    const table = menu?.tables.find(item => item.id === order.tableId)
    if (!table) { setError('This bill no longer has an available table. Refresh and try again.'); return }
    setSelectedTable(table.id)
    setFloor(table.floor)
    setTableViewOpen(true)
    setPreviewOrder(null)
    setServiceSection('tables')
    setOrderType('dine_in')
    chooseTableOrder(order)
    setShowRecallBill(false)
  }

  function startNewTableOrder(): void {
    if (!selectedTable || failedSubmission || submitting) return
    if ((cart.length > 0 || activeOrder) && !window.confirm('Start a separate new bill for this table? Unsaved items on the current screen will be cleared.')) return
    setActiveOrder(null)
    setKitchenMessage('')
    setShowKitchenMessage(false)
    setCart([])
    setLastPayment(null)
    setDiscountMode('none')
    setDiscountInput('0')
    setError('')
    setSavedMessage('New independent bill started for this table.')
  }

  function chooseDeliverySlot(deliveryNumber: number, edit = false): void {
    if (failedSubmission || submitting) return
    setSearch('')
    setSearchOpen(false)
    setSearchSelection(0)
    setDeliveryWhatsappOptIn(false)
    const order = activeDeliveryOrders.find((candidate) => candidate.deliveryNumber === deliveryNumber) ?? null
    setServiceSection('delivery')
    setOrderType('delivery')
    setParcelOrderOpen(false)
    setSelectedParcelNumber(null)
    setSelectedTable(null)
    setTableViewOpen(false)
    setDeliveryOrderOpen(!order || edit)
    setSelectedDeliveryNumber(deliveryNumber)
    setScheduledDeliveryAt(order?.scheduledDeliveryAt ?? null)
    setAssignedDeliveryTo(order?.assignedDeliveryTo ?? '')
    setActiveOrder(order)
    setKitchenMessage(order?.kitchenMessage ?? '')
    setShowKitchenMessage(false)
    setLastPayment(null)
    setCart([])
    setCustomerName(order?.customerName ?? '')
    setContactNumber(order?.contactNumber ?? '')
    setDeliveryAddress(order?.deliveryAddress ?? '')
    setDeliveryArea(order?.deliveryArea ?? '')
    setDeliveryLandmark(order?.deliveryLandmark ?? '')
    setDeliveryInstructions(order?.deliveryInstructions ?? '')
    setError('')
    setSavedMessage('')
    setPreviewOrder(order && !edit ? order : null)
    if (order?.discount?.kind === 'percentage') {
      setDiscountMode('percentage')
      setDiscountInput(String(order.discount.valueBps / 100))
    } else if (order?.discount?.kind === 'fixed') {
      setDiscountMode('fixed')
      setDiscountInput((order.discount.valuePaise / 100).toFixed(2))
    } else {
      setDiscountMode('none')
      setDiscountInput('0')
    }
    setShowDeliveryCustomerDialog(Boolean((!edit || !order) && order && (!order.contactNumber || !order.deliveryAddress)))
    setDeliveryCustomerStaged(false)
  }

  function chooseParcelSlot(parcelNumber: number, edit = false): void {
    if (failedSubmission || submitting) return
    setSearch('')
    setSearchOpen(false)
    setSearchSelection(0)
    setDeliveryCustomerStaged(false)
    const order = activeParcelOrders.find((candidate) => candidate.parcelNumber === parcelNumber) ?? null
    setServiceSection('parcel')
    setOrderType('parcel')
    setSelectedTable(null)
    setTableViewOpen(false)
    setDeliveryOrderOpen(false)
    setParcelOrderOpen(!order || edit)
    setSelectedDeliveryNumber(null)
    setSelectedParcelNumber(parcelNumber)
    setScheduledDeliveryAt(null)
    setAssignedDeliveryTo('')
    setActiveOrder(order)
    setKitchenMessage(order?.kitchenMessage ?? '')
    setShowKitchenMessage(false)
    setLastPayment(null)
    setCart([])
    setCustomerName(order?.customerName ?? '')
    setContactNumber(order?.contactNumber ?? '')
    setDeliveryAddress('')
    setDeliveryArea(order?.deliveryArea ?? '')
    setDeliveryLandmark('')
    setDeliveryInstructions('')
    setError('')
    setSavedMessage('')
    setPreviewOrder(order && !edit ? order : null)
    if (order?.discount?.kind === 'percentage') {
      setDiscountMode('percentage')
      setDiscountInput(String(order.discount.valueBps / 100))
    } else if (order?.discount?.kind === 'fixed') {
      setDiscountMode('fixed')
      setDiscountInput((order.discount.valuePaise / 100).toFixed(2))
    } else {
      setDiscountMode('none')
      setDiscountInput('0')
    }
  }

  function returnToServiceSlots(): void {
    const changedGuestDetails = customerName.trim() !== (activeOrder?.customerName ?? '')
      || contactNumber.trim() !== (activeOrder?.contactNumber ?? '')
      || deliveryAddress.trim() !== (activeOrder?.deliveryAddress ?? '')
      || deliveryArea.trim() !== (activeOrder?.deliveryArea ?? '')
      || deliveryLandmark.trim() !== (activeOrder?.deliveryLandmark ?? '')
      || deliveryInstructions.trim() !== (activeOrder?.deliveryInstructions ?? '')
    if ((cart.length > 0 || discountChanged || kitchenMessageChanged || changedGuestDetails) && !window.confirm(`Discard unsaved changes and return to ${serviceSection === 'delivery' ? 'delivery' : 'takeaway'} slots?`)) return
    setDeliveryOrderOpen(false)
    setParcelOrderOpen(false)
    setDeliveryCustomerStaged(false)
    setPreviewOrder(null)
    setSelectedDeliveryNumber(null)
    setSelectedParcelNumber(null)
    setScheduledDeliveryAt(null)
    setAssignedDeliveryTo('')
    setActiveOrder(null)
    setKitchenMessage('')
    setShowKitchenMessage(false)
    setLastPayment(null)
    setCart([])
    setDiscountMode('none')
    setDiscountInput('0')
    setCustomerName('')
    setContactNumber('')
    setDeliveryAddress('')
    setDeliveryArea('')
    setDeliveryLandmark('')
    setDeliveryInstructions('')
    setError('')
    setSavedMessage('')
  }

  function addProduct(product: Product): void {
    if (activeOrder?.savedAt) return
    if (failedSubmission || submitting || activeOrder?.status === 'paid' || activeOrder?.status === 'voided') return
    setCart((current) => {
      const found = current.find((line) => line.product.id === product.id)
      if (found) return current.map((line) => line.product.id === product.id ? { ...line, quantity: line.quantity + 1 } : line)
      return [...current, { product, quantity: 1, note: '' }]
    })
    setSelectedDraftProductId(product.id)
    setSavedMessage('')
  }

  function addSearchResult(product: Product): void {
    addProduct(product)
    searchInputRef.current?.focus()
    setSearch('')
    setSearchOpen(false)
    setSearchSelection(0)
  }

  function changeQuantity(productId: string, change: number): void {
    if (failedSubmission || submitting || activeOrder?.status === 'paid' || activeOrder?.status === 'voided') return
    setCart((current) => current.flatMap((line) => {
      if (line.product.id !== productId) return [line]
      const quantity = line.quantity + change
      return quantity > 0 ? [{ ...line, quantity }] : []
    }))
    setSelectedDraftProductId(productId)
    setSavedMessage('')
  }

  function removeDraftLine(productId: string): void {
    if (failedSubmission || submitting || activeOrder?.status === 'paid' || activeOrder?.status === 'voided') return
    setCart((current) => current.filter((line) => line.product.id !== productId))
    setSavedMessage('')
  }

  function clearDraft(): void {
    if (!canClearDraft || !window.confirm('Clear unsaved items and changes? Saved bill items will stay unchanged.')) return
    setCart([])
    setKitchenMessage(activeOrder?.kitchenMessage ?? '')
    setShowKitchenMessage(false)
    if (activeOrder?.discount?.kind === 'percentage') {
      setDiscountMode('percentage')
      setDiscountInput(String(activeOrder.discount.valueBps / 100))
    } else if (activeOrder?.discount?.kind === 'fixed') {
      setDiscountMode('fixed')
      setDiscountInput((activeOrder.discount.valuePaise / 100).toFixed(2))
    } else {
      setDiscountMode('none')
      setDiscountInput('0')
    }
    if (!activeOrder) {
      setCustomerName('')
      setContactNumber('')
      setDeliveryAddress('')
      setDeliveryArea('')
      setDeliveryLandmark('')
      setDeliveryInstructions('')
      setScheduledDeliveryAt(null)
      setAssignedDeliveryTo('')
    } else {
      setCustomerName(activeOrder.customerName)
      setContactNumber(activeOrder.contactNumber)
      setDeliveryAddress(activeOrder.deliveryAddress)
      setDeliveryArea(activeOrder.deliveryArea)
      setDeliveryLandmark(activeOrder.deliveryLandmark)
      setDeliveryInstructions(activeOrder.deliveryInstructions)
      setScheduledDeliveryAt(activeOrder.scheduledDeliveryAt)
      setAssignedDeliveryTo(activeOrder.assignedDeliveryTo)
    }
    setError('')
    setSavedMessage('')
  }

  function updateNote(productId: string, note: string): void {
    if (failedSubmission || submitting || activeOrder?.status === 'paid' || activeOrder?.status === 'voided') return
    setCart((current) => current.map((line) => line.product.id === productId ? { ...line, note } : line))
  }

  async function handleSetManagerPin(pin: string): Promise<void> {
    await setManagerPin(pin)
    setHasManagerPin(true)
    setManagerDialogMode(null)
    if (managementSetupRequested) {
      setManagementSetupRequested(false)
      setShowManagement(true)
    }
    setSavedMessage('Manager PIN set. Management and voids will require it.')
  }

  async function openManagement(): Promise<void> {
    setError('')
    try {
      const configured = await managerPinConfigured()
      setHasManagerPin(configured)
      if (!configured) {
        if (!canManageSettings) throw new Error('Ask the owner to set a manager PIN before opening Management.')
        setManagementSetupRequested(true)
        setManagerDialogMode('setup')
        return
      }
      setShowManagementPin(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Management access could not be checked.')
    }
  }

  async function handleAuthorizeManagement(pin: string): Promise<void> {
    await authorizeManagement(pin)
    setShowManagementPin(false)
    setShowManagement(true)
  }

  async function handleResetManagementPin(input: { ownerPassword: string; pin: string }): Promise<void> {
    await resetManagerPin(input)
    setHasManagerPin(true)
    setShowManagementPin(false)
    setShowManagement(true)
    setSavedMessage('Manager PIN changed. Use the new PIN for Management and voids.')
  }

  async function handleVoidOrder(pin: string, reason: string): Promise<void> {
    if (!activeOrder) throw new Error('Select an open bill before voiding.')
    const saved = await voidOrder({ orderId: activeOrder.id, pin, reason })
    setActiveOrder(null)
    setCart([])
    setLastPayment(null)
    setDiscountMode('none')
    setDiscountInput('0')
    setCustomerName('')
    setDeliveryAddress('')
    setDeliveryArea('')
    setDeliveryLandmark('')
    setDeliveryInstructions('')
    setManagerDialogMode(null)
    setSavedMessage(`Bill #${saved.orderNumber} voided and retained in history.`)
    try {
      await refreshMenu()
      setBillHistory(await listBillHistory())
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : 'The bill was voided but the screen could not refresh.'
      setError(`Bill #${saved.orderNumber} was voided, but the local view could not refresh: ${detail}`)
    }
  }

  async function handleVoidItem(itemId: string, quantity: number, pin: string, reason: string): Promise<void> {
    if (!activeOrder) throw new Error('Select an open bill before voiding an item.')
    const saved = await voidOrderItem({ orderId: activeOrder.id, itemId, quantity, pin, reason })
    setActiveOrder(saved)
    setShowItemVoid(false)
    setSavedMessage(`${quantity} item ${quantity === 1 ? 'portion' : 'portions'} voided from bill #${saved.orderNumber}.`)
    try {
      await refreshMenu()
      setBillHistory(await listBillHistory())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The item was voided but the screen could not refresh.')
    }
  }

  async function handleSplitBill(input: import('../../shared/domain').SplitOrderInput): Promise<void> {
    const result = await splitOrder(input)
    setActiveOrder(result.split)
    setShowSplitBill(false)
    setLastPayment(null)
    setSavedMessage(`Bill #${result.source.orderNumber} split into new bill #${result.split.orderNumber}.`)
    try { await refreshMenu() }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'The bills were split but the table could not refresh.') }
  }

  async function handleJoinBills(input: import('../../shared/domain').JoinOrdersInput): Promise<void> {
    const joined = await joinOrders(input)
    chooseTableOrder(joined)
    setSelectedTable(joined.tableId)
    setServiceSection('tables')
    setOrderType('dine_in')
    setParcelOrderOpen(false)
    setDeliveryOrderOpen(false)
    const table = menu?.tables.find(item => item.id === joined.tableId)
    if (table) setFloor(table.floor)
    setPreviewOrder(tableViewOpen ? null : joined)
    setShowJoinBill(false)
    setLastPayment(null)
    setSavedMessage(`Combined bill #${joined.orderNumber} created.`)
    try { await refreshMenu() }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'The bills were joined but the table could not refresh.') }
  }

  async function openDuplicateKot(): Promise<void> {
    if (!activeOrder || cart.length > 0 || activeOrder.status === 'paid' || activeOrder.status === 'voided') return
    setError('')
    try {
      await recordDuplicateKotRequest(activeOrder.id)
      setKitchenTicketDuplicate(true)
      setShowKitchenTicket(true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Duplicate kitchen ticket could not be prepared.')
    }
  }

  async function submitOrder(input = failedSubmission, reportFailureToCaller = false): Promise<boolean> {
    if (!input || submitting) return false
    setSubmitting(true)
    setError('')
    setSavedMessage('')
    try {
      const order = await createOrder(input)
      setActiveOrder(order)
      setKitchenMessage(order.kitchenMessage ?? '')
      setCart([])
      setFailedSubmission(null)
      setCustomerName(order.customerName)
      setContactNumber(order.contactNumber)
      setDeliveryAddress(order.deliveryAddress)
      setDeliveryArea(order.deliveryArea)
      setDeliveryLandmark(order.deliveryLandmark)
      setDeliveryInstructions(order.deliveryInstructions)
      setScheduledDeliveryAt(order.scheduledDeliveryAt)
      setAssignedDeliveryTo(order.assignedDeliveryTo)
      const latest = await refreshMenu()
      if (input.tableId) setSelectedTable(input.tableId)
      if (input.type !== 'dine_in') setServiceSection(input.type === 'parcel' ? 'parcel' : 'delivery')
      setSavedMessage(`Order ${formatOrderReference(order)} saved on this device`)
      if (order.type === 'delivery' && (!input.orderId || !order.contactNumber || !order.deliveryAddress)) {
        setShowDeliveryCustomerDialog(true)
      }
      if (input.tableId) {
        const latestOrder = latest.activeOrders.find((item) => item.id === order.id)
        if (latestOrder) setActiveOrder(latestOrder)
      }
      return true
    } catch (reason) {
      setFailedSubmission(input)
      const message = reason instanceof Error ? reason.message : 'Order could not be saved. Retry this same order.'
      setError(message)
      if (reportFailureToCaller) throw new Error(message)
      return false
    } finally {
      setSubmitting(false)
    }
  }

  async function saveDeliveryDetails(details: { scheduledDeliveryAt: string | null }): Promise<void> {
    if (activeOrder && !canEditDeliveryMetadata) {
      throw new Error('Save the delivery bill changes before scheduling or assigning this order.')
    }
    setScheduledDeliveryAt(details.scheduledDeliveryAt)
    if (activeOrder) {
      await updateDeliverySchedule({
        orderId: activeOrder.id,
        scheduledPickupAt: activeOrder.scheduledPickupAt,
        promisedDeliveryAt: details.scheduledDeliveryAt,
      })
      const saved = await getOrder(activeOrder.id)
      if (!saved) throw new Error('Delivery schedule was saved but the order could not be reloaded.')
      setActiveOrder(saved)
      setSavedMessage(`Schedule saved for ${formatOrderReference(saved)}.`)
      return
    }
    setSavedMessage('Delivery details will be saved when you submit this order.')
  }

  async function persistDeliveryCustomerDetails(details: DeliveryCustomerDetails, finish: boolean): Promise<void> {
    if (!activeOrder || activeOrder.type !== 'delivery') {
      throw new Error('Save the delivery order before entering customer details.')
    }
    const saved = await submitOrder({
      requestId: crypto.randomUUID(),
      type: 'delivery',
      tableId: null,
      customerName: details.customerName,
      contactNumber: details.contactNumber,
      deliveryAddress: details.deliveryAddress,
      deliveryArea: details.deliveryArea,
      deliveryLandmark: details.deliveryLandmark,
      deliveryInstructions: details.deliveryInstructions,
      kitchenMessage: activeOrder.kitchenMessage,
      deferKitchenTicket: !finish,
      prepareKitchenTicket: finish,
      whatsappBillOptIn: Boolean(details.whatsappBillOptIn),
      deliveryNumber: activeOrder.deliveryNumber,
      parcelNumber: null,
      scheduledDeliveryAt: details.scheduledDeliveryAt,
      items: [],
      discount: activeOrder.discount,
      orderId: activeOrder.id,
    }, true)
    if (!saved) throw new Error('An order save is already in progress. Please wait and retry.')
    if (details.scheduledDeliveryAt !== activeOrder.scheduledDeliveryAt) {
      await updateDeliverySchedule({ orderId: activeOrder.id,
        scheduledPickupAt: activeOrder.scheduledPickupAt, promisedDeliveryAt: details.scheduledDeliveryAt })
      const refreshed = await getOrder(activeOrder.id)
      if (refreshed) setActiveOrder(refreshed)
    }
    setScheduledDeliveryAt(details.scheduledDeliveryAt)
    setShowDeliveryCustomerDialog(false)
    setDeliveryCustomerStaged(!finish)
    setDeliveryWhatsappOptIn(Boolean(details.whatsappBillOptIn))
    if (finish) {
      setDeliveryOrderOpen(false)
      setKitchenTicketDuplicate(false)
      setShowKitchenTicket(true)
    } else {
      setSavedMessage('Customer saved. Press Done on the order to finish and view the KOT.')
    }
  }

  async function stageDeliveryCustomerDetails(details: DeliveryCustomerDetails): Promise<void> {
    await persistDeliveryCustomerDetails(details, false)
  }

  async function completeDeliveryCustomerDetails(details: DeliveryCustomerDetails): Promise<void> {
    await persistDeliveryCustomerDetails(details, true)
  }

  async function selectParcelCustomer(customer: DeliveryCustomerRecord): Promise<void> {
    if (!activeOrder || activeOrder.type !== 'parcel') throw new Error('Open a parcel order first.')
    const saved = await submitOrder({
      requestId: crypto.randomUUID(), type: 'parcel', tableId: null, orderId: activeOrder.id,
      parcelNumber: activeOrder.parcelNumber, deliveryNumber: null,
      customerName: customer.customerName, contactNumber: customer.contactNumber,
      deliveryAddress: '', deliveryArea: customer.deliveryArea || customer.deliveryAddress, items: [], discount: activeOrder.discount,
    }, true)
    if (!saved) throw new Error('Please wait for the order to finish saving and try again.')
    setShowParcelCustomerDialog(false)
    setParcelOrderOpen(false)
    setPreviewOrder(null)
  }

  async function openBillHistory(): Promise<void> {
    setShowHistory(true)
    setHistoryLoading(true)
    setHistoryError('')
    try {
      setBillHistory(await listBillHistory())
    } catch (reason) {
      setHistoryError(reason instanceof Error ? reason.message : 'Bill history could not be loaded.')
    } finally {
      setHistoryLoading(false)
    }
  }

  async function closeDeliverySchedule(): Promise<void> {
    setShowDeliverySchedule(false)
    try {
      await refreshMenu()
      if (activeOrder?.type === 'delivery') {
        const refreshed = await getOrder(activeOrder.id)
        if (!refreshed) throw new Error('The delivery order could not be reloaded.')
        setActiveOrder(refreshed)
        setScheduledDeliveryAt(refreshed.scheduledDeliveryAt)
        setAssignedDeliveryTo(refreshed.assignedDeliveryTo)
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The cashier view could not refresh delivery changes.')
    }
  }

  function beginDeliveryBoardAssignment(rider: { id: string; name: string }): void {
    setShowDeliverySchedule(false)
    setDeliveryBoardAssignment({ riderId: rider.id, riderName: rider.name, orderIds: [] })
    setDeliveryBoardAssignmentBusy(false)
    setServiceSection('delivery')
    setOrderType('delivery')
    setDeliveryOrderOpen(false)
    setSelectedDeliveryNumber(null)
    setActiveOrder(null)
    setPreviewOrder(null)
    setError('')
    void refreshMenu().catch(cause => setError(cause instanceof Error ? cause.message : 'Unable to refresh HD cards for assignment.'))
  }

  function toggleDeliveryBoardAssignment(order: SavedOrder): void {
    if (!deliveryBoardAssignment || deliveryBoardAssignmentBusy) return
    const selectable = order.type === 'delivery'
      && order.deliveryStatus === 'pending'
      && !order.deliveryRiderId
      && ['ordering', 'preparing', 'ready'].includes(order.status)
      && order.status !== 'voided'
    if (!selectable) return
    setDeliveryBoardAssignment(current => current ? {
      ...current,
      orderIds: current.orderIds.includes(order.id)
        ? current.orderIds.filter(id => id !== order.id)
        : [...current.orderIds, order.id],
    } : null)
  }

  async function saveDeliveryBoardAssignment(): Promise<void> {
    const assignment = deliveryBoardAssignment
    if (!assignment || !assignment.orderIds.length || deliveryBoardAssignmentBusy) return
    setDeliveryBoardAssignmentBusy(true)
    setError('')
    try {
      await assignDeliveryRiderBatch({ orderIds: assignment.orderIds, riderId: assignment.riderId })
      const printErrors: string[] = []
      let printed = 0
      if (window.desktopPrinting) {
        for (const orderId of assignment.orderIds) {
          try {
            await window.desktopPrinting.request({ orderId, kind: 'bill' })
            printed += 1
          } catch { printErrors.push(orderId) }
        }
      }
      await refreshMenu()
      setDeliveryBoardAssignment(null)
      setShowDeliverySchedule(true)
      setSavedMessage(`${assignment.orderIds.length} HD bill${assignment.orderIds.length === 1 ? '' : 's'} assigned to ${assignment.riderName}.${window.desktopPrinting ? ` ${printed} bill print request${printed === 1 ? '' : 's'} queued.` : ' Open the desktop app to print the bills.'}`)
      if (printErrors.length) setError(`${printErrors.length} assigned bill print request${printErrors.length === 1 ? '' : 's'} could not be queued. Check Desktop Printers and retry from the HD card.`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The selected HD bills could not be assigned. Refresh and try again.')
    } finally {
      setDeliveryBoardAssignmentBusy(false)
    }
  }

  function selectHistoricalBill(entry: BillHistoryEntry): void {
    const { order, payment } = entry
    setActiveOrder(order)
    setLastPayment(payment)
    setPaymentMethod(payment?.method === 'split' ? 'cash' : payment?.method ?? 'cash')
    setSelectedTable(order.tableId)
    setTableViewOpen(order.tableId !== null)
    setDeliveryOrderOpen(order.type === 'delivery')
    setParcelOrderOpen(order.type === 'parcel')
    setSelectedDeliveryNumber(order.deliveryNumber)
    setSelectedParcelNumber(order.parcelNumber)
    setScheduledDeliveryAt(order.scheduledDeliveryAt)
    setAssignedDeliveryTo(order.assignedDeliveryTo)
    setServiceSection(order.type === 'dine_in' ? 'tables' : order.type === 'parcel' ? 'parcel' : 'delivery')
    setOrderType(order.type)
    if (order.tableId) {
      const table = menu?.tables.find((candidate) => candidate.id === order.tableId)
      if (table) setFloor(table.floor)
    }
    setCart([])
    setCustomerName(order.customerName)
    setContactNumber(order.contactNumber)
    setDeliveryAddress(order.deliveryAddress)
    setDeliveryArea(order.deliveryArea)
    setDeliveryLandmark(order.deliveryLandmark)
    setDeliveryInstructions(order.deliveryInstructions)
    if (order.discount?.kind === 'percentage') {
      setDiscountMode('percentage')
      setDiscountInput(String(order.discount.valueBps / 100))
    } else if (order.discount?.kind === 'fixed') {
      setDiscountMode('fixed')
      setDiscountInput((order.discount.valuePaise / 100).toFixed(2))
    } else {
      setDiscountMode('none')
      setDiscountInput('0')
    }
    setError('')
    setSavedMessage('')
    setShowHistory(false)
    setShowSavedBills(false)
  }

  async function openSavedBill(order: SavedOrder): Promise<void> {
    if (submitting || paymentSubmitting || failedSubmission || failedPayment) {
      setError('Resolve the current order or payment attempt before opening a saved bill.'); return
    }
    if ((cart.length || discountChanged) && !window.confirm('Discard unsaved changes and open this saved bill?')) return
    try {
      const latest = await getOrder(order.id)
      if (!latest) throw new Error('Saved bill not found. Refresh restaurant data.')
      if (latest.status === 'paid' || latest.status === 'voided') {
        await refreshMenu(); setError('This saved bill was already closed.'); return
      }
      selectHistoricalBill({ order: latest, payment: null })
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to open saved bill.') }
  }

  async function settleBill(order: SavedOrder, method: PaymentMethod = paymentMethod): Promise<void> {
    if (order.status === 'paid' || order.status === 'voided' || paymentSubmitting) return
    if (failedPayment && failedPayment.orderId !== order.id) {
      setError('Resolve the previous payment attempt before paying a different bill.')
      return
    }

    const input = failedPayment ?? {
      requestId: crypto.randomUUID(),
      orderId: order.id,
      method,
    }
    setFailedPayment(input)
    setPaymentSubmitting(true)
    setError('')
    let paymentSaved = false
    try {
      const payment = await recordPayment(input)
      paymentSaved = true
      const savedOrder = await getOrder(order.id)
      if (!savedOrder) throw new Error('The payment was recorded, but the bill could not be reloaded.')
      await refreshMenu()
      setFailedPayment(null)
      setService(savedOrder.type === 'dine_in' ? 'tables' : savedOrder.type === 'parcel' ? 'parcel' : 'delivery')
      setSavedMessage(`Bill #${savedOrder.orderNumber} paid in full by ${payment.method.toUpperCase()}.`)
      try { setBillHistory(await listBillHistory()) }
      catch { setError('The bill is paid and its card is clear. Refresh Bill history to see the latest receipt.') }
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : 'Payment could not be confirmed.'
      setError(paymentSaved
        ? `Payment was recorded, but the local view could not be refreshed. Retry safely with the same request: ${detail}`
        : detail)
    } finally {
      setPaymentSubmitting(false)
    }
  }

  async function takeCashAndClose(order: SavedOrder): Promise<void> {
    if (!canCashClose || cashActionInProgress.current) return
    cashActionInProgress.current = true
    setCashChecking(true)
    setError('')
    try {
      const latest = await getOrder(order.id)
      if (!latest || latest.status === 'paid' || latest.status === 'voided' || latest.status === 'joined') {
        await refreshMenu()
        throw new Error('This bill is no longer open. Refresh the card before taking payment.')
      }
      const ledger = await getPaymentLedger(order.id)
      if (ledger.settled || ledger.balancePaise <= 0) throw new Error('This bill has no cash balance due.')
      const reference = latest.type === 'parcel' ? `P-${latest.parcelNumber}` : `table ${menu?.tables.find(table => table.id === latest.tableId)?.name ?? latest.tableId}`
      if (!window.confirm(`Confirm ${formatMoney(ledger.balancePaise)} cash received for ${reference}, bill #${latest.orderNumber}?\nThis will mark the bill paid and clear its card.`)) return
      await settleBill(latest, 'cash')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to check the cash balance. Try again.')
    } finally {
      cashActionInProgress.current = false
      setCashChecking(false)
    }
  }

  async function openDeliveryCashOut(order: SavedOrder): Promise<void> {
    if (cashChecking || deliveryCashOut) return
    setCashChecking(true)
    setError('')
    try {
      const latest = await getOrder(order.id)
      if (!latest || latest.type !== 'delivery' || latest.status === 'voided' || latest.status === 'joined')
        throw new Error('This HD bill is no longer available. Refresh the delivery board.')
      const blockedReason = deliveryCashOutBlockReason(latest)
      if (blockedReason) throw new Error(blockedReason)
      const ledger = await getPaymentLedger(order.id)
      setDeliveryCashOut({ order: latest, balancePaise: ledger.balancePaise, requestId: crypto.randomUUID() })
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not check this HD bill.') }
    finally { setCashChecking(false) }
  }

  async function confirmDeliveryCashOut(pin: string): Promise<void> {
    if (!deliveryCashOut) return
    const { order, balancePaise, requestId } = deliveryCashOut
    const result = await cashOutDelivery({ requestId, orderId: order.id, pin, expectedBalancePaise: balancePaise })
    setDeliveryCashOut(null)
    setService('delivery')
    setSavedMessage(`${formatOrderReference(order)} cash-out complete. ${result.collectedPaise > 0 ? `${formatMoney(result.collectedPaise)} cash recorded.` : 'Previously recorded payment retained.'}`)
    try { await refreshMenu(); setBillHistory(await listBillHistory()) }
    catch { setError('Cash-out completed. Refresh the delivery board to see the cleared HD card.') }
  }

  function acceptStaffLogin(authenticatedStaff: StaffIdentity): void {
    setError('')
    setLoading(true)
    setStaffAccess({ needsOwnerSetup: false, staff: authenticatedStaff })
  }

  async function handleStaffLogout(): Promise<void> {
    try {
      await logoutStaff()
      setStaffAccess({ needsOwnerSetup: false, staff: null })
      setMenu(null)
      setActiveOrder(null)
      setCart([])
      setBillHistory([])
      setLastPayment(null)
      setCustomerName('')
      setContactNumber('')
      setDeliveryAddress('')
      setShowManagement(false)
      setShowManagementPin(false)
      setManagementSetupRequested(false)
      setShowWaiter(false)
      setShowPaymentLedger(false)
      setShowStaffManagement(false)
      setShowHistory(false)
      setShowInvoice(false)
      setShowKitchenTicket(false)
      setManagerDialogMode(null)
      setFailedPayment(null)
      setFailedSubmission(null)
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Staff could not be signed out.')
    }
  }

  async function retryStaffAccess(): Promise<void> {
    setLoading(true)
    setError('')
    try {
      setStaffAccess(await getStaffAccessState())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Staff access could not be checked.')
    } finally {
      setLoading(false)
    }
  }

  function startSubmit(): void {
    if (failedSubmission) {
      void submitOrder(failedSubmission).then(saved => {
        if (saved && !(failedSubmission.type === 'delivery' && (!failedSubmission.orderId || !failedSubmission.contactNumber?.trim() || !failedSubmission.deliveryAddress?.trim()))) {
          setTableViewOpen(false)
          setParcelOrderOpen(false)
          setDeliveryOrderOpen(false)
        }
        if (saved && deliveryCustomerStaged) {
          setDeliveryCustomerStaged(false)
          setKitchenTicketDuplicate(false)
          setShowKitchenTicket(true)
        }
      })
      return
    }
    if (deliveryCustomerStaged && cart.length === 0 && !discountChanged && !deliveryDetailsChanged && !kitchenMessageChanged) {
      void completeDeliveryCustomerDetails({ customerName, contactNumber, deliveryAddress,
        deliveryArea, deliveryLandmark, deliveryInstructions, scheduledDeliveryAt,
        whatsappBillOptIn: deliveryWhatsappOptIn }).catch(reason =>
        setError(reason instanceof Error ? reason.message : 'The delivery order could not be completed.'))
      return
    }
    if (cart.length === 0 && !discountChanged && !deliveryDetailsChanged && !kitchenMessageChanged) return
    const input: CreateOrderInput = {
      requestId: crypto.randomUUID(),
      type: orderType,
      tableId: orderType === 'dine_in' ? selectedTable : null,
      customerName: customerName.trim(),
      contactNumber: contactNumber.trim(),
      deliveryAddress: deliveryAddress.trim(),
      deliveryArea: orderType === 'delivery' || orderType === 'parcel' ? deliveryArea.trim() : '',
      deliveryLandmark: orderType === 'delivery' ? deliveryLandmark.trim() : '',
      deliveryInstructions: orderType === 'delivery' ? deliveryInstructions.trim() : '',
      kitchenMessage: kitchenMessage.trim(),
      deferKitchenTicket: orderType === 'delivery' && !deliveryCustomerStaged
        && (!activeOrder || !contactNumber.trim() || !deliveryAddress.trim()),
      prepareKitchenTicket: orderType === 'delivery' && deliveryCustomerStaged,
      whatsappBillOptIn: orderType === 'delivery' && deliveryCustomerStaged && deliveryWhatsappOptIn,
      deliveryNumber: orderType === 'delivery' ? selectedDeliveryNumber : null,
      parcelNumber: orderType === 'parcel' ? selectedParcelNumber : null,
      scheduledDeliveryAt: orderType === 'delivery' ? scheduledDeliveryAt : null,
      items: cart.map(({ product, quantity, note }) => ({
        productId: product.id,
        quantity,
        note: note.trim(),
      })),
      discount: parsedDiscount.discount,
      ...(activeOrder ? { orderId: activeOrder.id } : {}),
    }
    setFailedSubmission(input)
    void submitOrder(input).then(saved => {
      if (saved && !(input.type === 'delivery' && (!input.orderId || !input.contactNumber?.trim() || !input.deliveryAddress?.trim()))) {
        setTableViewOpen(false)
        setParcelOrderOpen(false)
        setDeliveryOrderOpen(false)
      }
      if (saved && deliveryCustomerStaged) {
        setDeliveryCustomerStaged(false)
        setKitchenTicketDuplicate(false)
        setShowKitchenTicket(true)
      }
    })
  }

  useEffect(() => {
    const handleOrderShortcut = (event: KeyboardEvent) => {
      if (!orderEditorOpen || showOrderShortcuts || event.repeat || document.querySelector('[aria-modal="true"]')) return
      const shortcut = shortcutFromEvent(event)
      if (!shortcut) return
      const action = Object.entries(orderShortcuts).find(([, key]) => key === shortcut)?.[0]
      if (!action) return
      const target = event.target as HTMLElement | null
      const editing = Boolean(target?.closest('input, textarea, select, [contenteditable="true"]'))
      if (editing && action !== 'search') return
      event.preventDefault()
      switch (action) {
        case 'done':
          if (canSaveInvoice || (failedSubmission && !submitting)) startSubmit()
          break
        case 'reduce': {
          const line = cart.find(item => item.product.id === selectedDraftProductId) ?? cart.at(-1)
          if (line) changeQuantity(line.product.id, -1)
          break
        }
        case 'search': searchInputRef.current?.focus(); break
        case 'discount': if (canApplyDiscount) document.getElementById('discount-mode')?.focus(); break
        case 'printBill':
          if (activeOrder && cart.length === 0 && activeOrder.status !== 'voided') {
            if (window.desktopPrinting && printableTable) setTablePrint({ table: printableTable, kind: 'bill' })
            else setShowInvoice(true)
          }
          break
        case 'recall': if (recallableBills.length) setShowRecallBill(true); break
        case 'voidItem': if (canVoidItem) setShowItemVoid(true); break
      }
    }
    window.addEventListener('keydown', handleOrderShortcut)
    return () => window.removeEventListener('keydown', handleOrderShortcut)
  })

  useEffect(() => {
    const handleSlotShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (!staff || !staffHasPermission(staff.role, 'pos:access') || orderEditorOpen || showManagement || showWaiter || showDeliverySchedule || deliveryBoardAssignment || event.repeat
        || target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
        || document.querySelector('[aria-modal="true"], [role="dialog"]')) return
      const shortcut = cardShortcutFromEvent(event)
      const action = Object.entries(cardShortcuts).find(([, value]) => value === shortcut)?.[0]
      if (!action) return
      event.preventDefault()
      if (action === 'parcel') {
        const freeSlot = parcelSlots.find(slot => !slot.order)
        if (freeSlot) chooseParcelSlot(freeSlot.parcelNumber)
        else setError('All parcel cards are in use.')
        return
      }
      if (action === 'delivery') {
        const freeSlot = deliverySlots.find(slot => !slot.order)
        if (freeSlot) chooseDeliverySlot(freeSlot.deliveryNumber)
        else setError('All home delivery cards are in use.')
        return
      }
      const wantedFloor = action === 'ground'
        ? floors.find(name => name.toLocaleLowerCase().includes('ground'))
        : floors.find(name => /^(floor\s*1|1st\s*floor)$/i.test(name.trim()))
      if (!wantedFloor) {
        setError(action === 'ground' ? 'Ground Floor was not found.' : 'Floor 1 was not found.')
        return
      }
      const freeTable = menu?.tables.find(table => table.floor === wantedFloor && table.status === 'available')
      if (freeTable) chooseTable(freeTable)
      else {
        setFloor(wantedFloor)
        setServiceSection('tables')
        setError(`No available tables on ${wantedFloor}.`)
      }
    }
    window.addEventListener('keydown', handleSlotShortcut)
    return () => window.removeEventListener('keydown', handleSlotShortcut)
  })

  const selectedTableData = menu?.tables.find((table) => table.id === selectedTable)
  if (loading && !staffAccess) {
    return <main className="loading-screen"><div className="brand-mark"><UtensilsCrossed size={22} /></div><span>Checking staff access…</span></main>
  }
  if (!staffAccess) {
    return <main className="staff-no-module"><div className="brand-mark"><UtensilsCrossed size={22} /></div><h1>Cannot check staff access</h1><p role="alert">{error || 'The local staff database is unavailable.'}</p><button onClick={() => void retryStaffAccess()}>Retry</button></main>
  }
  if (staffAccess && !staffAccess.staff) {
    return <StaffAccessScreen needsOwnerSetup={staffAccess.needsOwnerSetup} onAuthenticated={acceptStaffLogin} />
  }
  if (branchControlMode && staff) {
    if (!staffHasPermission(staff.role, 'menu:manage')) return <main className="staff-no-module"><h1>Branch Control</h1><p>A manager or owner account is required.</p><button onClick={() => void handleStaffLogout()}>Sign out</button></main>
    return <RestaurantManagement staff={staff} theme={theme} onThemeChange={setTheme} cardShortcuts={cardShortcuts} onCardShortcutsChange={setCardShortcuts} orderShortcuts={orderShortcuts} onOrderShortcutsChange={setOrderShortcuts} onClose={() => void handleStaffLogout()} />
  }
  if (staff && !staffHasPermission(staff.role, 'pos:access')) {
    if (staff.role === 'waiter') return <WaiterScreen staff={staff} onClose={() => void handleStaffLogout()} />
    if (staffHasPermission(staff.role, 'reports:view') || staffHasPermission(staff.role, 'inventory:manage') || staffHasPermission(staff.role, 'kitchen:operate')) return <RestaurantManagement staff={staff} theme={theme} onThemeChange={setTheme} cardShortcuts={cardShortcuts} onCardShortcutsChange={setCardShortcuts} orderShortcuts={orderShortcuts} onOrderShortcutsChange={setOrderShortcuts} onClose={() => void handleStaffLogout()} />
    return (
      <main className="staff-no-module">
        <div className="brand-mark"><UtensilsCrossed size={22} /></div>
        <h1>Signed in as {staff.displayName}</h1>
        <p>Your <b>{staff.role}</b> account is active, but this build does not yet include that role’s workspace. Sign out and use a cashier, manager, or owner account to access POS billing.</p>
        <button onClick={() => void handleStaffLogout()}><LogOut size={15} />Sign out</button>
      </main>
    )
  }
  if (loading) {
    return <main className="loading-screen"><div className="brand-mark"><UtensilsCrossed size={22} /></div><span>Opening your restaurant…</span></main>
  }
  if (!staff) {
    return <main className="loading-screen"><div className="brand-mark"><UtensilsCrossed size={22} /></div><span>Staff session is unavailable.</span></main>
  }

  return (
    <div className={`app-shell ${theme === 'dark' ? 'dark-mode' : ''} ${orderEditorOpen ? 'order-entry-active' : ''}`}>
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-logo" src={billmitraLogo} alt="BillMitra" />
          <div className="brand-copy"><strong>BillMitra</strong><span>RESTAURANT POS</span></div>
        </div>
        <button className="branch-select" disabled={!onChangeBranch} onClick={onChangeBranch}><span className="branch-dot" /><span><b>{branchName}</b><small>{onChangeBranch ? 'Switch branch' : 'Current restaurant'}</small></span><ChevronDown size={15} /></button>
        <div className="side-label">WORKSPACE</div>
        {serviceSection === 'tables' && (
          <button
            className={`floor-link all-tables-link ${floor === 'All tables' && !tableViewOpen ? 'selected' : ''}`}
            onClick={() => { setService('tables'); setFloor('All tables') }}
          >
            <span className={`floor-dot ${floor === 'All tables' && !tableViewOpen ? 'selected' : ''}`} />
            All tables
            <span className="floor-occupancy">{menu?.tables.length ?? 0}</span>
          </button>
        )}
        <button className={`side-link ${serviceSection === 'parcel' ? 'active' : ''}`} onClick={() => setService('parcel')}>
          <ShoppingBag size={18} /><span>Takeaway</span><span className="nav-chevron">›</span>
        </button>
        <button className={`side-link ${serviceSection === 'delivery' ? 'active' : ''}`} onClick={() => setService('delivery')}>
          <ArrowDownRight size={18} /><span>Home delivery</span><span className="nav-chevron">›</span>
        </button>
        {canViewDeliveries && <button className="side-link" onClick={() => setShowDeliverySchedule(true)}>
          <CalendarClock size={18} /><span>Delivery schedule</span><span className="nav-chevron">›</span>
        </button>}
        <button className="side-link" onClick={() => void openBillHistory()}>
          <History size={18} /><span>Bill history</span><span className="nav-chevron">›</span>
        </button>
        <div className="side-label floor-label">FLOORS</div>
        {floors.map((name) => (
          <button key={name} className={`floor-link ${floor === name && serviceSection === 'tables' ? 'selected' : ''}`} onClick={() => { setFloor(name); setService('tables') }}>
            <span className={`floor-dot ${floor === name && serviceSection === 'tables' ? 'selected' : ''}`} />{name}
            <span className="floor-occupancy">{menu?.tables.filter((table) => table.floor === name && table.status !== 'available').length ?? 0}</span>
          </button>
        ))}
        <div className="sidebar-spacer" />
        <div className={`sidebar-status ${menu && !liveError ? '' : 'disconnected'}`}><span className={`online-dot ${menu && !liveError ? '' : 'offline'}`} /><span><b>{connected ? (liveError ? 'Connection lost' : 'Shared branch server') : (menu ? 'Local database active' : 'Local data unavailable')}</b><small>{connected ? (liveError ? 'Check the restaurant server connection' : 'Same branch as waiter phones') : (menu ? 'Offline-ready · This device' : 'Check the local database connection')}</small></span></div>
        <button className="profile" onClick={() => void handleStaffLogout()} title="Sign out">
          <span className="avatar">{staff.displayName.slice(0, 2).toUpperCase()}</span><span><b>{staff.displayName}</b><small>{staff.role} · {connected ? 'Connected account' : 'Local account'}</small></span><LogOut size={14} />
        </button>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div className="breadcrumb"><span>Restaurant</span><span>/</span><b>{activeOrder?.savedAt ? `Saved bill #${activeOrder.orderNumber}` : serviceSection === 'tables' ? tableViewOpen && selectedTableData ? `Table ${selectedTableData.name}` : 'All tables' : serviceSection === 'parcel' ? 'Takeaway' : 'Home delivery'}</b></div>
          <div className="topbar-actions">
            <button className="staff-management-button" onClick={() => setShowSavedBills(true)}>Saved Bills ({savedBills.length})</button>
            <DesktopPrinters />
            {staffHasPermission(staff.role, 'waiter:operate') && <button className="staff-management-button" onClick={() => setShowWaiter(true)}>Waiter</button>}
            {staffHasPermission(staff.role, 'menu:manage') && <button className="staff-management-button" onClick={() => void openManagement()}>Management</button>}
            {canManageStaff && <button className="staff-management-button" onClick={() => setShowStaffManagement(true)}><Users size={14} />Staff</button>}
            <div className="live-indicator" title={liveError || undefined}><span className={`online-dot${liveError ? ' offline' : ''}`} /> {connected ? liveError ? 'CONNECTION LOST' : 'CONNECTED · 5S REFRESH' : 'LOCAL MODE'}</div>
            <span className="top-divider" />
            <div className="date-time"><b>{clock.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</b><span>{clock.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}</span></div>
            <button className="avatar top-avatar" aria-label={`Sign out ${staff.displayName}`} title={`Sign out ${staff.displayName}`} onClick={() => void handleStaffLogout()}>{staff.displayName.slice(0, 2).toUpperCase()}</button>
          </div>
        </header>

        <div className={`workspace ${orderEditorOpen ? 'order-editor-open' : 'service-board-open'} ${previewOrder ? 'order-preview-open' : ''}`}>
          {previewOrder && <aside className="order-preview-panel" aria-label={`Preview bill ${previewOrder.orderNumber}`}>
            <header><div><span className="eyebrow">ORDER PREVIEW</span><h2>{formatOrderReference(previewOrder)} · Bill #{previewOrder.orderNumber}</h2><small>{previewOrder.type === 'dine_in' ? `Table ${selectedTableData?.name ?? previewOrder.tableId ?? '—'}` : previewOrder.type === 'delivery' ? previewOrder.customerName || 'Delivery customer pending' : previewOrder.customerName || 'Takeaway guest pending'}</small></div><button onClick={() => { setPreviewOrder(null); setActiveOrder(null) }}>Close</button></header>
            <div className="preview-status"><span className={`status-dot ${previewOrder.status}`} />{previewOrder.type === 'delivery' && deliveryCashOutBlockReason(previewOrder) ? previewOrder.deliveryStatus : previewOrder.status.replace('_', ' ')}</div>
            <div className="preview-items">{previewOrder.items.map(item => <div key={item.id}><span><b>{item.productName}</b>{item.note && <small>{item.note}</small>}</span><span>{item.quantity} × {formatMoney(item.unitPricePaise)}<b>{formatMoney(item.quantity * item.unitPricePaise)}</b></span></div>)}</div>
            <div className="preview-total"><span>Total</span><b>{formatMoney(previewOrder.totalPaise)}</b></div>
            <p>Preview only. Use Recall to edit this bill.</p>
            <div className="preview-actions">
              {previewOrder.type === 'parcel' && previewOrder.status !== 'paid' && previewOrder.status !== 'voided' && <button className="preview-recall" onClick={() => setShowParcelCustomerDialog(true)}><Users size={16} />Customer · optional</button>}
              <button className="preview-recall" onClick={() => recallBill(previewOrder)}><Search size={16} />Recall & edit bill</button>
              {(previewOrder.type === 'dine_in' || previewOrder.type === 'parcel') && <button className="preview-cash" onClick={() => void takeCashAndClose(previewOrder)} disabled={!canCashClose}><Wallet size={16} />{cashChecking || paymentSubmitting ? 'Checking cash…' : 'Cash · close bill'}</button>}
              {previewOrder.type === 'delivery' && staffHasPermission(staff.role, 'payments:record') && (deliveryCashOutBlockReason(previewOrder)
                ? <div className="preview-cash-unavailable"><span>{deliveryCashOutBlockReason(previewOrder)}</span><button type="button" onClick={() => { setPreviewOrder(null); setActiveOrder(null); setShowDeliverySchedule(true) }}>Open Delivery schedule</button></div>
                : <button className="preview-cash" onClick={() => void openDeliveryCashOut(previewOrder)} disabled={cashChecking}><Wallet size={16} />{cashChecking ? 'Checking bill…' : 'Cash out · manager PIN'}</button>)}
            </div>
          </aside>}
          <section className={`catalog-panel ${tableViewOpen || deliveryOrderOpen || parcelOrderOpen ? 'table-order-catalog' : serviceSection === 'delivery' || serviceSection === 'parcel' ? 'delivery-slot-catalog' : ''}`}>
            {!!savedBills.length && <div className="alert success-alert" role="status"><span>{savedBills.length} bill{savedBills.length === 1 ? '' : 's'} saved by waiters. Payment still due.</span><button onClick={() => setShowSavedBills(true)}>View Saved Bills</button></div>}
            {!orderEditorOpen && error && <div className="alert error-alert" role="alert"><span>{error}</span></div>}
            {!orderEditorOpen && savedMessage && <div className="alert success-alert" role="status"><Check size={16} />{savedMessage}</div>}
            {activeOrder?.savedAt && activeOrder.status !== 'paid' && activeOrder.status !== 'voided' && <div className="alert success-alert"><span>Saved bill #{activeOrder.orderNumber} · Former table {activeOrder.savedTableName} · {activeOrder.savedTableFloor} · Saved by {activeOrder.savedBy}. Review the items and record payment to close this bill.</span></div>}
            {!tableViewOpen && !deliveryOrderOpen && !parcelOrderOpen && serviceSection !== 'parcel' && serviceSection !== 'delivery' && <div className="page-heading">
              <div>
                <div className="eyebrow">{serviceSection === 'tables' ? tableViewOpen ? 'DINE-IN ORDER' : 'SERVICE FLOOR' : 'NEW ORDER'}</div>
                <h1>{serviceSection === 'tables' ? tableViewOpen && selectedTableData ? `Table ${selectedTableData.name}` : floor : 'Home delivery'}</h1>
                <p>{serviceSection === 'tables' ? tableViewOpen ? `Add dishes to this table's bill · ${selectedTableData?.floor ?? floor}` : `Select a table to start or continue an order. Shortcuts: ${cardShortcuts.ground} Ground Floor · ${cardShortcuts.first} Floor 1.` : 'Create an order and add delivery details.'}</p>
              </div>
              {serviceSection === 'tables' && !tableViewOpen && (
                <div className="floor-switch">
                  {['All tables', ...floors].map((name) => (
                    <button key={name} className={floor === name ? 'selected' : ''} onClick={() => setFloor(name)}>{name}</button>
                  ))}
                </div>
              )}
            </div>}

            {serviceSection === 'tables' && !tableViewOpen && (
              <>
                <div className="floor-summary">
                  <div className="summary-metric"><span className="summary-icon occupied"><Armchair size={17} /></span><span><strong>{visibleTables.filter((table) => table.status !== 'available').length}</strong><small>Occupied</small></span></div>
                  <div className="summary-metric"><span className="summary-icon free"><Check size={17} /></span><span><strong>{visibleTables.filter((table) => table.status === 'available').length}</strong><small>Available</small></span></div>
                  <div className="summary-metric"><span className="summary-icon guests"><Users size={17} /></span><span><strong>{visibleTables.reduce((sum, table) => sum + table.capacity, 0)}</strong><small>Total seats</small></span></div>
                  <div className="summary-action"><span>Updated just now</span><span className="refresh-mark">↻</span></div>
                </div>
                <div className="section-heading"><h2>Tables <span className="muted-count">{visibleTables.length}</span></h2><div className="table-legend"><span><i className="legend-dot open" />Available</span><span><i className="legend-dot timer-open" />Under 1 hour</span><span><i className="legend-dot timer-overdue" />1 hour or more</span></div></div>
                <div className="table-grid">
                  {visibleTables.map((table) => {
                    return (
                      <RestaurantTableCard
                        key={table.id}
                        table={table}
                        selected={selectedTable === table.id}
                        onSelect={chooseTable}
                        now={deliveryTimerNow}
                        onPrint={window.desktopPrinting ? (selected, kind) => setTablePrint({ table: selected, kind }) : undefined}
                      />
                    )
                  })}
                </div>
              </>
            )}

            {serviceSection === 'delivery' && !deliveryOrderOpen && (
              <section className="delivery-slot-board" aria-labelledby="delivery-slots-title">
                <div className="delivery-slot-heading">
                  <div><h1 id="delivery-slots-title">{deliveryBoardAssignment ? `Assign HD bills · ${deliveryBoardAssignment.riderName}` : 'Delivery orders'}</h1><p>{deliveryBoardAssignment ? 'Tap each eligible HD card to select it. Selected cards turn green.' : `Shortcut: ${cardShortcuts.delivery} opens the first available delivery card.`}</p></div>
                  <div className="delivery-slot-heading-actions"><label className="delivery-card-search"><Search size={15} /><input value={deliveryCardSearch} onChange={event => setDeliveryCardSearch(event.target.value)} placeholder="Search name, phone or place" aria-label="Search delivery cards by customer, phone or place" />{deliveryCardSearch && <button type="button" onClick={() => setDeliveryCardSearch('')}>Clear</button>}</label><div className="delivery-slot-count"><b>{occupiedDeliverySlots}</b><span>of {deliverySlots.length} active</span></div></div>
                </div>
                <div className="delivery-slot-grid service-slot-grid">
                  {visibleDeliverySlots.map(({ deliveryNumber, order }) => {
                    const assignmentEligible = Boolean(order && deliveryBoardAssignment
                      && order.deliveryStatus === 'pending' && !order.deliveryRiderId
                      && ['ordering', 'preparing', 'ready'].includes(order.status) && order.status !== 'voided')
                    const assignmentSelected = Boolean(order && deliveryBoardAssignment?.orderIds.includes(order.id))
                    return (
                    <article key={deliveryNumber} className={`service-slot-tile timer-${order ? tableOrderTimer({ orderId: order.id, startedAt: order.createdAt }, deliveryTimerNow).state : 'available'}`}>
                    <button
                      className={`delivery-slot-card ${order ? 'occupied' : 'available'} timer-${order ? tableOrderTimer({ orderId: order.id, startedAt: order.createdAt }, deliveryTimerNow).state : 'available'} ${assignmentSelected ? 'assignment-selected' : ''} ${deliveryBoardAssignment && !assignmentEligible ? 'assignment-unavailable' : ''}`}
                      onClick={() => deliveryBoardAssignment && order ? toggleDeliveryBoardAssignment(order) : chooseDeliverySlot(deliveryNumber)}
                      disabled={deliveryBoardAssignment ? !assignmentEligible || deliveryBoardAssignmentBusy : Boolean(failedSubmission) || submitting}
                      aria-label={order
                        ? `Continue HD-${deliveryNumber}, ${order.customerName}, ${order.assignedDeliveryTo ? `rider ${order.assignedDeliveryTo}` : 'no rider assigned'}, elapsed ${elapsedClockLabel(order.createdAt, deliveryTimerNow)}, ${order.scheduledDeliveryAt ? `scheduled ${new Date(order.scheduledDeliveryAt).toLocaleString('en-IN')}` : 'no delivery time scheduled'}, ${formatMoney(order.totalPaise)}`
                        : `Start delivery order HD-${deliveryNumber}`}
                    >
                      <span className="delivery-slot-number">HD-{deliveryNumber}</span>
                      <span className="delivery-slot-status"><i />{order ? deliveryCashOutBlockReason(order) ? order.deliveryStatus : order.status.replace('_', ' ') : 'Available'}</span>
                      {order && (
                        <>
                          <span className="delivery-slot-place">
                            Place: {order.deliveryArea || order.deliveryLandmark || order.deliveryAddress || 'Not added'}
                          </span>
                          <span className="delivery-slot-meta delivery-slot-rider">
                            {order.assignedDeliveryTo ? `Rider: ${order.assignedDeliveryTo}` : 'Rider: Unassigned'}
                          </span>
                          <span className="delivery-slot-meta delivery-slot-elapsed" aria-label={`Elapsed ${elapsedClockLabel(order.createdAt, deliveryTimerNow)}`}>
                            {elapsedClockLabel(order.createdAt, deliveryTimerNow) || 'Timer unavailable'}
                          </span>
                          {order.scheduledDeliveryAt && (
                            <span className="delivery-slot-meta delivery-slot-time">
                              Delivery: {new Date(order.scheduledDeliveryAt).toLocaleString('en-IN', {
                                day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
                              })}
                            </span>
                          )}
                          <b className="delivery-slot-total">{formatMoney(order.totalPaise)}</b>
                        </>
                      )}
                    </button>
                    {order && window.desktopPrinting && !deliveryBoardAssignment && <div className="table-print-actions"><button onClick={() => setTablePrint({ table: printTargetForOrder(order), kind: 'bill' })}><Printer size={13} />Print Bill</button><button onClick={() => setTablePrint({ table: printTargetForOrder(order), kind: 'kot' })}><Printer size={13} />Print KOT</button></div>}
                    </article>
                    )
                  })}
                </div>
                {!!deliveryCardSearch.trim() && visibleDeliverySlots.length === 0 && <p className="delivery-card-search-empty">No HD card matches “{deliveryCardSearch.trim()}”.</p>}
                {deliveryBoardAssignment && <div className="delivery-board-assignment-actions"><span><b>{deliveryBoardAssignment.orderIds.length}</b> HD bill{deliveryBoardAssignment.orderIds.length === 1 ? '' : 's'} selected for {deliveryBoardAssignment.riderName}</span><div><button onClick={() => { setDeliveryBoardAssignment(null); setShowDeliverySchedule(true) }} disabled={deliveryBoardAssignmentBusy}>Cancel</button><button className="primary" onClick={() => void saveDeliveryBoardAssignment()} disabled={!deliveryBoardAssignment.orderIds.length || deliveryBoardAssignmentBusy}>{deliveryBoardAssignmentBusy ? 'Assigning and printing…' : `Assign and print ${deliveryBoardAssignment.orderIds.length} bill${deliveryBoardAssignment.orderIds.length === 1 ? '' : 's'}`}</button></div></div>}
              </section>
            )}

            {serviceSection === 'parcel' && !parcelOrderOpen && (
              <section className="delivery-slot-board" aria-labelledby="parcel-slots-title">
                <div className="delivery-slot-heading">
                  <div><h1 id="parcel-slots-title">Parcel orders</h1><p>Shortcut: {cardShortcuts.parcel} opens the first available parcel card.</p></div>
                  <div className="delivery-slot-heading-actions"><label className="delivery-card-search"><Search size={15} /><input value={parcelCardSearch} onChange={event => setParcelCardSearch(event.target.value)} placeholder="Search name or phone" aria-label="Search parcel cards by customer or phone" />{parcelCardSearch && <button type="button" onClick={() => setParcelCardSearch('')}>Clear</button>}</label><div className="delivery-slot-count"><b>{occupiedParcelSlots}</b><span>of {parcelSlots.length} active</span></div></div>
                </div>
                <div className="delivery-slot-grid service-slot-grid">
                  {visibleParcelSlots.map(({ parcelNumber, order }) => (
                    <article key={parcelNumber} className={`service-slot-tile timer-${order ? tableOrderTimer({ orderId: order.id, startedAt: order.createdAt }, deliveryTimerNow).state : 'available'}`}>
                    <button
                      className={`delivery-slot-card ${order ? 'occupied' : 'available'} timer-${order ? tableOrderTimer({ orderId: order.id, startedAt: order.createdAt }, deliveryTimerNow).state : 'available'}`}
                      onClick={() => chooseParcelSlot(parcelNumber)}
                      disabled={Boolean(failedSubmission) || submitting}
                      aria-label={order ? `Continue P-${parcelNumber}, ${order.customerName}, ${formatMoney(order.totalPaise)}` : `Start takeaway order P-${parcelNumber}`}
                    >
                      <span className="delivery-slot-number">P-{parcelNumber}</span>
                      <span className="delivery-slot-status"><i />{order ? order.status.replace('_', ' ') : 'Available'}</span>
                      {order && <><span className="delivery-slot-customer">{order.customerName || order.contactNumber}</span><span className="delivery-slot-meta delivery-slot-elapsed">{elapsedClockLabel(order.createdAt, deliveryTimerNow) || 'Timer unavailable'}</span><b className="delivery-slot-total">{formatMoney(order.totalPaise)}</b></>}
                    </button>
                    {order && <div className="table-print-actions"><button onClick={() => { chooseParcelSlot(parcelNumber); setShowParcelCustomerDialog(true) }} disabled={Boolean(failedSubmission) || submitting || order.status === 'paid' || order.status === 'voided'}><Users size={13} />Customer</button>{window.desktopPrinting && <><button onClick={() => setTablePrint({ table: printTargetForOrder(order), kind: 'bill' })}><Printer size={13} />Print Bill</button><button onClick={() => setTablePrint({ table: printTargetForOrder(order), kind: 'kot' })}><Printer size={13} />Print KOT</button></>}</div>}
                    </article>
                  ))}
                </div>
                {!!parcelCardSearch.trim() && visibleParcelSlots.length === 0 && <p className="delivery-card-search-empty">No parcel card matches “{parcelCardSearch.trim()}”.</p>}
              </section>
            )}

            {orderEditorOpen && <div className={`menu-selector table-order-menu`}>
              {(deliveryOrderOpen || parcelOrderOpen) && <div className="delivery-menu-context"><button className="back-to-delivery-slots" onClick={returnToServiceSlots}><ArrowLeft size={14} />All {deliveryOrderOpen ? 'HD' : 'P'} slots</button><span><b>{deliveryOrderOpen ? `HD-${selectedDeliveryNumber}` : `P-${selectedParcelNumber}`}</b><small>{deliveryOrderOpen ? 'Home delivery order' : 'Takeaway order'}</small></span></div>}
              {tableViewOpen && selectedTableData && <div className="table-orders-context">
                <div><button className="back-to-tables" onClick={() => setTableViewOpen(false)}><ArrowLeft size={14} />Tables</button><span><b>Table {selectedTableData.name}</b><small>{selectedTableData.floor} · {selectedTableOrders.length} active bill{selectedTableOrders.length === 1 ? '' : 's'}</small></span></div>
                <div className="table-order-tabs">
                  {selectedTableOrders.map((order) => <button key={order.id} className={activeOrder?.id === order.id ? 'selected' : ''} onClick={() => chooseTableOrder(order)}>Bill #{order.orderNumber}<small>{formatMoney(order.totalPaise)}</small></button>)}
                  <button className={!activeOrder ? 'selected new-table-order' : 'new-table-order'} onClick={startNewTableOrder}><Plus size={14} />New</button>
                </div>
              </div>}
            <div className="menu-heading">
              <div><div className="eyebrow">THE MENU</div><h2>Choose from the menu</h2></div>
            </div>
            <div className="category-list">
              <button className={`category-chip ${categoryId === 'all' ? 'selected' : ''}`} onClick={() => setCategoryId('all')}><span className="category-icon all"><UtensilsCrossed size={15} /></span>All items</button>
              {menu?.categories.map((category) => {
                const Icon = categoryIcons[category.id] ?? Soup
                return <button key={category.id} className={`category-chip ${categoryId === category.id ? 'selected' : ''}`} onClick={() => setCategoryId(category.id)}><span className={`category-icon ${category.id}`}><Icon size={15} /></span>{category.name}</button>
              })}
            </div>
            {error && <div className="alert error-alert"><span>{error}</span>{failedSubmission && <button onClick={() => void submitOrder(failedSubmission)}>Retry same order</button>}</div>}
            {savedMessage && <div className="alert success-alert"><Check size={16} />{savedMessage}<span className="sync-pill">{connected ? 'Saved to branch server' : 'Saved locally'}</span></div>}
            <div className="product-grid">
              {visibleProducts.map((product, index) => (
                <button key={product.id} className={`product-card product-tone-${index % 5}`} onClick={() => addProduct(product)} disabled={Boolean(failedSubmission) || submitting || Boolean(activeOrder?.savedAt) || activeOrder?.status === 'paid' || activeOrder?.status === 'voided'}>
                  <span className="dish-art"><span>{product.categoryId === 'drinks' ? '🥭' : product.categoryId === 'breads' ? '🫓' : product.categoryId === 'desserts' ? '🍮' : product.categoryId === 'starters' ? '🍢' : '🍛'}</span><i /></span>
                  <span className="product-details"><strong>{product.name}</strong><small>{product.description}</small><b>{formatMoney(product.pricePaise)}</b></span>
                  <span className="add-product"><Plus size={15} /></span>
                </button>
              ))}
              {visibleProducts.length === 0 && <div className="empty-results">No dishes match that search.</div>}
            </div>
            </div>}
            <footer className="catalog-footer"><span><span className={`online-dot ${menu ? '' : 'offline'}`} />{menu ? 'Menu ready' : 'Menu unavailable'}</span><span>Prices in INR · GST rates are demo configuration</span><span>Find items from the bill panel</span></footer>
          </section>

          {orderEditorOpen && <aside className={`order-panel ${serviceSection === 'delivery' ? 'delivery-order-panel' : ''}`}>
            <div className="bill-search-toolbar">
              <div className="bill-item-search" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setSearchOpen(false) }}>
                <div className="search-box"><Search size={17} />
                  <input id="bill-menu-search" aria-label="Search menu items" ref={searchInputRef} value={search} role="combobox" aria-autocomplete="list" aria-expanded={searchOpen} aria-controls="bill-menu-results" aria-activedescendant={searchOpen && searchResults[searchSelection] ? `bill-menu-result-${searchResults[searchSelection].id}` : undefined} onChange={event => { setSearch(event.target.value); setSearchSelection(0); setSearchOpen(Boolean(event.target.value.trim())) }} onKeyDown={event => {
                    if (event.key === 'ArrowDown') { event.preventDefault(); setSearchSelection(current => searchOpen ? Math.min(current + 1, Math.max(0, searchResults.length - 1)) : 0); setSearchOpen(true) }
                    else if (event.key === 'ArrowUp') { event.preventDefault(); setSearchSelection(current => searchOpen ? Math.max(current - 1, 0) : Math.max(0, searchResults.length - 1)); setSearchOpen(true) }
                    else if (event.key === 'Enter') { event.preventDefault(); if (searchResults[searchSelection] && (searchOpen || search.trim())) addSearchResult(searchResults[searchSelection]) }
                    else if (event.key === 'Escape') { event.preventDefault(); setSearchOpen(false) }
                  }} placeholder="Search item" disabled={Boolean(failedSubmission) || submitting || Boolean(activeOrder?.savedAt) || activeOrder?.status === 'paid' || activeOrder?.status === 'voided'} autoComplete="off" />
                  <button className="menu-search-arrow" type="button" aria-label={searchOpen ? 'Hide menu suggestions' : 'Show menu suggestions'} aria-expanded={searchOpen} aria-controls="bill-menu-results" onMouseDown={event => event.preventDefault()} onClick={() => { if (searchOpen) setSearchOpen(false); else { searchInputRef.current?.focus(); setSearchOpen(true) } }} disabled={Boolean(failedSubmission) || submitting || Boolean(activeOrder?.savedAt) || activeOrder?.status === 'paid' || activeOrder?.status === 'voided'}><ChevronDown size={18} /></button>
                </div>
                {searchOpen && <div id="bill-menu-results" ref={searchResultsRef} className="bill-search-results" role="listbox" aria-label="Menu search results">
                  {searchResults.length ? searchResults.map((product, index) => <button key={product.id} id={`bill-menu-result-${product.id}`} className={`bill-search-result ${index === searchSelection ? 'selected' : ''}`} role="option" aria-selected={index === searchSelection} onMouseEnter={() => setSearchSelection(index)} onClick={() => addSearchResult(product)} disabled={Boolean(failedSubmission) || submitting || Boolean(activeOrder?.savedAt) || activeOrder?.status === 'paid' || activeOrder?.status === 'voided'}><span><b>{product.name}</b><small>{menu?.categories.find(category => category.id === product.categoryId)?.name ?? product.categoryId}</small></span><strong>{formatMoney(product.pricePaise)}</strong><Plus size={16} /></button>) : <div className="bill-search-empty">No available menu items found.</div>}
                </div>}
              </div>
              <button type="button" onClick={() => { setCategoryId('all'); document.querySelector('.table-order-menu .category-list')?.scrollIntoView({ block: 'nearest' }) }}>Category</button>
              <button type="button" aria-expanded={showKitchenMessage} aria-controls="order-kitchen-message" onClick={() => setShowKitchenMessage(open => !open)} disabled={Boolean(activeOrder?.savedAt) || activeOrder?.status === 'paid' || activeOrder?.status === 'voided'}>Kitchen msg</button>
              <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => { if (searchResults[searchSelection]) addSearchResult(searchResults[searchSelection]) }} disabled={(!searchOpen && !search.trim()) || !searchResults[searchSelection] || Boolean(failedSubmission) || submitting || Boolean(activeOrder?.savedAt) || activeOrder?.status === 'paid' || activeOrder?.status === 'voided'}>Enter</button>
              <button type="button" onClick={() => document.getElementById('bill-extra-actions')?.scrollIntoView({ block: 'nearest' })}>Xtra</button>
            </div>
            {showKitchenMessage && <label id="order-kitchen-message" className="order-kitchen-message">Message for kitchen ticket
              <textarea value={kitchenMessage} onChange={event => setKitchenMessage(event.target.value)} maxLength={300} placeholder="Example: No onion; prepare this order first" disabled={Boolean(activeOrder?.savedAt) || activeOrder?.status === 'paid' || activeOrder?.status === 'voided'} />
              <small>Saved with this order and shown on the kitchen ticket. Press Done to send it.</small>
            </label>}
            <div className="order-panel-heading">
              <div><div className="eyebrow">CURRENT BILL</div><h2>{activeOrder ? `Order ${formatOrderReference(activeOrder)}` : orderType === 'delivery' ? 'New delivery' : orderType === 'parcel' ? 'New takeaway' : 'New order'}</h2></div>
              <div className="bill-header-actions">
                {activeOrder && <button className="bill-action-button print-bill-button" onClick={() => {
                  if (window.desktopPrinting && printableTable && activeOrder.status !== 'paid' && activeOrder.status !== 'voided') setTablePrint({ table: printableTable, kind: 'bill' })
                  else setShowInvoice(true)
                }}><Printer size={15} />Print bill</button>}
                {activeOrder && activeOrder.status !== 'voided' && <button className="bill-action-button" disabled={cart.length > 0 || discountChanged || paymentSubmitting || Boolean(failedPayment)} onClick={() => setShowPaymentLedger(true)}>Split payment / refunds</button>}
                <button className="bill-action-button clear-draft-button" onClick={clearDraft} disabled={!canClearDraft}><Trash2 size={15} />Clear draft</button>
              </div>
            </div>
            <div className="order-type-toggle">
              <button className={orderType === 'dine_in' ? 'selected' : ''} onClick={() => setService('tables')}><Armchair size={15} />Dine in</button>
              <button className={orderType === 'parcel' ? 'selected' : ''} onClick={() => setService('parcel')}><ShoppingBag size={15} />Takeaway</button>
              <button className={orderType === 'delivery' ? 'selected' : ''} onClick={() => setService('delivery')}><ArrowDownRight size={15} />Delivery</button>
            </div>
            {orderType === 'dine_in' ? (
              <button className={`selected-table-card ${selectedTableData ? 'has-table' : ''}`} onClick={() => {
                if (tableViewOpen) setTableViewOpen(false)
                else setService('tables')
              }}>
                <span className="table-chip-icon"><Armchair size={17} /></span><span><small>{activeOrder?.savedAt ? 'FORMER TABLE' : 'TABLE'}</small><b>{activeOrder?.savedAt ? `Table ${activeOrder.savedTableName}` : selectedTableData ? `Table ${selectedTableData.name}` : 'Choose a table'}</b></span>{selectedTableData && <span className="table-chip-seats"><Users size={13} />{selectedTableData.capacity}</span>}
              </button>
            ) : (
              <div className="guest-fields">
                {(orderType === 'delivery' || orderType === 'parcel') && <div className="delivery-reference"><span>{orderType === 'delivery' ? 'HOME DELIVERY NO.' : 'TAKEAWAY NO.'}</span><b>{orderType === 'delivery' ? selectedDeliveryNumber === null ? activeOrder ? formatOrderReference(activeOrder) : 'Select an HD card' : `HD-${selectedDeliveryNumber}` : selectedParcelNumber === null ? activeOrder ? formatOrderReference(activeOrder) : 'Select a P card' : `P-${selectedParcelNumber}`}</b></div>}
                {orderType === 'delivery' && !activeOrder && <div className="delivery-customer-prompt">Add dishes, then press <b>Done</b>. Customer details will be requested next.</div>}
                {orderType === 'delivery' && activeOrder && (
                  <>
                    <label><span>Customer name (optional)</span><input value={customerName} onChange={(event) => setCustomerName(event.target.value)} placeholder="Name for this order (optional)" disabled={Boolean(failedSubmission) || activeOrder.status === 'paid' || activeOrder.status === 'voided'} /></label>
                    <label><span>Contact number (required)</span><input type="tel" value={contactNumber} onChange={(event) => setContactNumber(event.target.value)} placeholder="Required phone number" autoComplete="tel" required disabled={Boolean(failedSubmission) || activeOrder.status === 'paid' || activeOrder.status === 'voided'} /></label>
                    <label><span>Delivery address (required)</span><textarea value={deliveryAddress} onChange={(event) => setDeliveryAddress(event.target.value)} placeholder="Required: street, area and location details" autoComplete="street-address" required rows={2} disabled={Boolean(failedSubmission) || activeOrder.status === 'paid' || activeOrder.status === 'voided'} /></label>
                    <label><span>Area / neighbourhood</span><input value={deliveryArea} onChange={(event) => setDeliveryArea(event.target.value)} maxLength={120} placeholder="Area" disabled={Boolean(failedSubmission) || activeOrder.status === 'paid' || activeOrder.status === 'voided'} /></label>
                    <label><span>Building / landmark</span><input value={deliveryLandmark} onChange={(event) => setDeliveryLandmark(event.target.value)} maxLength={160} placeholder="Building or landmark" disabled={Boolean(failedSubmission) || activeOrder.status === 'paid' || activeOrder.status === 'voided'} /></label>
                    <label><span>Delivery instructions</span><textarea value={deliveryInstructions} onChange={(event) => setDeliveryInstructions(event.target.value)} maxLength={300} rows={2} placeholder="Optional rider instructions" disabled={Boolean(failedSubmission) || activeOrder.status === 'paid' || activeOrder.status === 'voided'} /></label>
                  </>
                )}
                {orderType === 'parcel' && <div className="parcel-customer-option"><span>Customer details are optional</span><button type="button" onClick={() => setShowParcelCustomerDialog(true)} disabled={!activeOrder || Boolean(failedSubmission) || submitting || activeOrder.status === 'paid' || activeOrder.status === 'voided'}>Customer · search or add</button>{activeOrder?.contactNumber && <small>{activeOrder.customerName || 'Customer'} · {activeOrder.contactNumber}</small>}</div>}
              </div>
            )}
            <div className="order-status-row"><span className={`status-dot ${activeOrder?.status ?? 'ordering'}`} />{activeOrder?.status === 'paid' ? 'Paid' : activeOrder?.status === 'voided' ? 'Voided' : activeOrder?.savedAt ? 'Saved · payment due' : activeOrder ? `Open · ${activeOrder.status.replace('_', ' ')}` : 'Not submitted'}<span>{itemCount} {itemCount === 1 ? 'item' : 'items'}</span></div>
            <div className="bill-items-heading"><strong>Bill items</strong><span>{itemCount} {itemCount === 1 ? 'item' : 'items'}</span></div>
            <div className="cart-content">
              {existingLines.length === 0 && cart.length === 0 ? (
                <div className="empty-cart"><div className="empty-cart-icon"><ShoppingBag size={23} /></div><b>Your order starts here</b><span>Choose a table, then tap a dish to add it.</span></div>
              ) : (
                <>
                  {existingLines.length > 0 && <div className="cart-section-title">SAVED ITEMS <span>Already on order</span></div>}
                  {existingLines.map((item) => <div className="cart-item saved-item" key={item.id}><div className="cart-item-info"><strong>{item.productName}</strong>{item.note && <small>Note: {item.note}</small>}<span>{item.quantity} × {formatMoney(item.unitPricePaise)}</span></div><div className="cart-item-right"><button className="remove-line-button" onClick={() => setShowItemVoid(true)} aria-label={`Void ${item.productName}`} title="Void item or quantity" disabled={!canVoidItem}><Ban size={14} /></button><b>{formatMoney(item.quantity * item.unitPricePaise)}</b></div></div>)}
                  {cart.length > 0 && <div className="cart-section-title">{activeOrder ? 'ADD TO ORDER' : 'ORDER ITEMS'}<span>Unsaved</span></div>}
                  {cart.map(({ product, quantity, note }) => (
                    <div className={`cart-item draft-item ${selectedDraftProductId === product.id ? 'shortcut-selected-item' : ''}`} key={product.id}>
                      <div className="cart-item-info"><strong>{product.name}</strong><span>{formatMoney(product.pricePaise)} each</span><input aria-label={`Note for ${product.name}`} className="item-note" value={note} onChange={(event) => updateNote(product.id, event.target.value)} placeholder="+ Add a note" disabled={Boolean(failedSubmission) || activeOrder?.status === 'paid' || activeOrder?.status === 'voided'} /></div>
                      <div className="cart-item-right">
                        <div className="cart-line-controls">
                          <button type="button" className="shortcut-select-item" onClick={() => setSelectedDraftProductId(product.id)} aria-label={`Select ${product.name} for quantity shortcut`} aria-pressed={selectedDraftProductId === product.id}>Select</button>
                          <div className="quantity-stepper"><button onClick={() => changeQuantity(product.id, -1)} aria-label={`Remove one ${product.name}`} disabled={Boolean(failedSubmission)}><Minus size={12} /></button><span>{quantity}</span><button onClick={() => changeQuantity(product.id, 1)} aria-label={`Add one ${product.name}`} disabled={Boolean(failedSubmission)}><Plus size={12} /></button></div>
                          <button className="remove-line-button" onClick={() => removeDraftLine(product.id)} aria-label={`Remove ${product.name} from unsaved items`} title="Remove unsaved item" disabled={Boolean(failedSubmission)}><Trash2 size={14} /></button>
                        </div>
                        <b>{formatMoney(quantity * product.pricePaise)}</b>
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>
            <div id="bill-extra-actions" className="right-action-grid" aria-label="Bill actions"><div className="bill-actions-title">More bill actions</div>
              {canManageSettings && <button className="right-action" onClick={() => setShowOrderShortcuts(true)} title="Customize keyboard shortcuts on this device"><Keyboard size={15} />Shortcuts</button>}
              <button className="right-action danger" onClick={() => setManagerDialogMode('void')} disabled={!canVoidBill} title={!canVoidBills ? 'Manager or owner permission is required to void bills' : !hasManagerPin ? 'Set a manager PIN before voiding bills' : cart.length > 0 || discountChanged ? 'Save or clear unsaved changes before voiding' : 'Voiding requires a manager PIN and a reason'}>
                <Ban size={15} />Void bill
              </button>
              <button className="right-action danger" onClick={() => setShowItemVoid(true)} disabled={!canVoidItem} title={!canVoidItem ? 'Select an unpaid saved bill with items; save or clear changes first' : 'Void one item or part of an item quantity'}>
                <Ban size={15} />Void item
              </button>
              <button className="right-action" onClick={() => setShowSplitBill(true)} disabled={!canSplitBill} title={!canSplitBill ? 'Select an unpaid dine-in bill with two or more items and no unsaved changes' : 'Move selected quantities to a new independent bill'}>
                <CopyPlus size={15} />Split bill
              </button>
              <button className="right-action" onClick={() => setShowJoinBill(true)} disabled={!canJoinBill} title={!canJoinBill ? 'Save the current draft before joining bills' : 'Choose two active dine-in bills to combine'}>
                <GitMerge size={15} />Join bills
              </button>
              <button className="right-action" onClick={() => setShowRecallBill(true)} disabled={!recallableBills.length} title="Open an active dine-in, takeaway, or delivery bill for editing">
                <Search size={15} />Recall bill
              </button>
              {!hasManagerPin && canManageSettings && <button className="right-action security-setup" onClick={() => setManagerDialogMode('setup')}><ShieldCheck size={15} />Set manager PIN</button>}
              <button className="right-action unavailable" disabled title="Staff calling is available when the waiter module is implemented">Call staff</button>
              <button className="right-action" onClick={() => {
                if (window.desktopPrinting && printableTable && activeOrder) setTablePrint({ table: printableTable, kind: 'kot' })
                else void openDuplicateKot()
              }} disabled={!activeOrder || cart.length > 0 || activeOrder.status === 'paid' || activeOrder.status === 'voided'} title={cart.length > 0 ? 'Save added items before printing a kitchen ticket' : 'Choose a saved kitchen batch to print'}>
                <Printer size={15} />{window.desktopPrinting && activeOrder?.type === 'dine_in' ? 'Print KOT' : 'Duplicate KOT'}
              </button>
              {activeOrder?.status === 'voided' && <span className="void-reason-note">Reason: {activeOrder.voidReason}</span>}
            </div>
            <div className="discount-editor">
              <label htmlFor="discount-mode">Discount</label>
              <select id="discount-mode" value={discountMode} onChange={(event) => {
                setDiscountMode(event.target.value as DiscountMode)
                setSavedMessage('')
              }} disabled={!canApplyDiscount || Boolean(failedSubmission) || submitting || activeOrder?.status === 'paid' || activeOrder?.status === 'voided'}>
                <option value="none">No discount</option>
                <option value="percentage">Percentage</option>
                <option value="fixed">Fixed amount</option>
              </select>
              {discountMode !== 'none' && (
                <div className="discount-value-wrap">
                  <input
                    aria-label={discountMode === 'percentage' ? 'Discount percentage' : 'Discount amount in rupees'}
                    type="number"
                    min="0"
                    max={discountMode === 'percentage' ? '100' : undefined}
                    step={discountMode === 'percentage' ? '0.01' : '0.01'}
                    value={discountInput}
                    onChange={(event) => { setDiscountInput(event.target.value); setSavedMessage('') }}
                    disabled={!canApplyDiscount || Boolean(failedSubmission) || submitting || activeOrder?.status === 'paid' || activeOrder?.status === 'voided'}
                  />
                  <span>{discountMode === 'percentage' ? '%' : 'INR'}</span>
                </div>
              )}
              {!canApplyDiscount && <small className="discount-permission-note">Manager or owner permission is required to change discounts.</small>}
              {parsedDiscount.error && <small className="discount-error">{parsedDiscount.error}</small>}
            </div>
            <div className="bill-summary">
              <div><span>Subtotal</span><b>{formatMoney(subtotalPaise)}</b></div>
              {discountPaise > 0 && <div><span>Discount</span><b>−{formatMoney(discountPaise)}</b></div>}
              <div><span>GST <small>(demo rates)</small></span><b>{formatMoney(taxPaise)}</b></div>
              <div className="bill-total"><span>Total due</span><b>{formatMoney(totalPaise)}</b></div>
            </div>
            <button className="submit-order" onClick={startSubmit} disabled={failedSubmission ? submitting : !canSaveInvoice}>
              {submitting ? <><span className="button-spinner" />Saving to this device…</> : failedSubmission ? <><ArrowUpRight size={17} />Retry saving invoice</> : deliveryCustomerStaged ? <><Check size={17} />Done · prepare KOT</> : activeOrder && cart.length === 0 ? <><Check size={17} />Update invoice</> : activeOrder ? <><Plus size={17} />Done · Save changes</> : <><Check size={17} />Done · Save bill</>}
              {!submitting && !failedSubmission && <span>{formatMoney(totalPaise)}</span>}
            </button>
            <div className="save-note"><span className="online-dot" /> {connected ? 'Shared branch data' : 'Saved locally on this device'} <span>·</span> {connected ? 'Desktop and waiter phones' : 'No cloud sync'}</div>
            {activeOrder?.status === 'voided' ? (
              <div className="payment-hint voided-payment-hint"><Ban size={15} />Voided bill · payment is disabled.</div>
            ) : activeOrder ? (
              <div className={`payment-box ${activeOrder.status === 'paid' ? 'settled' : ''}`}>
                {activeOrder.status === 'paid' ? (
                  <>
                    <div className="payment-confirmed"><Check size={15} /><span><b>Paid in full</b><small>{lastPayment ? `${lastPayment.method.toUpperCase()} · ${new Date(`${lastPayment.paidAt.replace(' ', 'T')}Z`).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}` : 'Payment saved on this device'}</small></span></div>
                    <button className="payment-receipt-button" onClick={() => setShowInvoice(true)}>View paid invoice</button>
                  </>
                ) : cart.length > 0 ? (
                  <div className="payment-hint"><Wallet size={15} />Save added items before taking payment.</div>
                ) : (
                  <>
                    <label htmlFor="payment-method">Full payment method</label>
                    <select
                      id="payment-method"
                      value={paymentMethod}
                      onChange={(event) => setPaymentMethod(event.target.value as PaymentMethod)}
                      disabled={paymentSubmitting || Boolean(failedPayment)}
                    >
                      <option value="cash">Cash</option>
                      <option value="upi">UPI</option>
                      <option value="card">Card (external terminal)</option>
                    </select>
                    <button className="record-payment-button" onClick={() => void settleBill(activeOrder)} disabled={paymentSubmitting}>
                      {paymentSubmitting ? <><span className="button-spinner" />Recording payment…</> : failedPayment ? 'Retry payment confirmation' : 'Record full payment'}
                      <b>{formatMoney(activeOrder.totalPaise)}</b>
                    </button>
                    <small>Records a local payment entry only. No card data is collected.</small>
                  </>
                )}
              </div>
            ) : (
              <div className="payment-teaser"><div><CreditCard size={16} /><span>Payment due when bill is saved</span></div><Wallet size={16} /></div>
            )}
            {serviceSection === 'delivery' && (
              <div className="delivery-bottom-actions" aria-label="Delivery actions">
                <button
                  className="delivery-bottom-action"
                  onClick={() => setShowDeliveryScheduleDialog(true)}
                  disabled={selectedDeliveryNumber === null || submitting || Boolean(failedSubmission) || (Boolean(activeOrder) && !canEditDeliveryMetadata)}
                  title={selectedDeliveryNumber === null ? 'Select a delivery slot first' : deliveryBillHasUnsavedChanges ? 'Save bill changes before scheduling' : 'Set or change the scheduled delivery time'}
                >
                  <CalendarClock size={17} />
                  <span><b>Delivery Schedules</b><small>{selectedDeliveryNumber === null ? 'Select an HD order' : scheduledDeliveryAt ? new Date(scheduledDeliveryAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : activeOrder ? 'Not scheduled' : 'Set before placing'}</small></span>
                </button>
                <button
                  className="delivery-bottom-action"
                  onClick={() => setShowDeliverySchedule(true)}
                  disabled={!canViewDeliveries}
                  title="Open the saved delivery schedule to assign an eligible rider"
                >
                  <Truck size={17} />
                  <span><b>Assign Delivery</b><small>{!activeOrder ? 'Open delivery schedule' : assignedDeliveryTo || 'Choose an eligible rider'}</small></span>
                </button>
              </div>
            )}
          </aside>}
        </div>
        <nav className={`pos-action-bar ${serviceSection !== 'delivery' ? 'with-cash' : ''} ${orderEditorOpen ? 'order-entry-actions' : ''}`} aria-label="POS quick actions">
          <button onClick={startNewTableOrder} disabled={!selectedTable || serviceSection !== 'tables' || submitting}><Plus size={17} /><span>New</span></button>
          <button onClick={() => activeOrder && setShowInvoice(true)} disabled={!activeOrder}><Printer size={17} /><span>Receipt</span></button>
          <button onClick={() => setShowPaymentLedger(true)} disabled={!activeOrder || activeOrder.status === 'voided' || cart.length > 0}><CreditCard size={17} /><span>Payment</span></button>
          <button onClick={() => setShowRecallBill(true)} disabled={!recallableBills.length}><Search size={17} /><span>Recall</span></button>
          <button onClick={() => activeOrder && setShowSplitBill(true)} disabled={!canSplitBill}><CopyPlus size={17} /><span>Split</span></button>
          <button onClick={() => setShowJoinBill(true)} disabled={!canJoinBill} title={!canJoinBill ? 'Save the current draft before joining bills' : 'Choose two active dine-in bills to combine'}><GitMerge size={17} /><span>Join</span></button>
          <button onClick={() => {
            if (!activeOrder) return
            if (window.desktopPrinting && printableTable) setTablePrint({ table: printableTable, kind: 'bill' })
            else setShowInvoice(true)
          }} disabled={!activeOrder || cart.length > 0 || activeOrder.status === 'voided'}><Printer size={17} /><span>Print bill</span></button>
          <button onClick={() => {
            if (!activeOrder) return
            if (window.desktopPrinting && printableTable) setTablePrint({ table: printableTable, kind: 'kot' })
            else void openDuplicateKot()
          }} disabled={!activeOrder || cart.length > 0 || activeOrder.status === 'paid' || activeOrder.status === 'voided'}><Printer size={17} /><span>Print KOT</span></button>
          {serviceSection !== 'delivery' && <button className="quick-cash-action" onClick={() => activeOrder && void takeCashAndClose(activeOrder)} disabled={!canCashClose} title="Confirm cash received and close the selected dining or parcel bill"><Wallet size={17} /><span>Cash</span></button>}
          <button onClick={() => { if (tableViewOpen) setTableViewOpen(false); else returnToServiceSlots() }} disabled={!tableViewOpen && !deliveryOrderOpen && !parcelOrderOpen}><Check size={17} /><span>Close</span></button>
        </nav>
      </main>
      {showInvoice && activeOrder && <InvoicePreview order={activeOrder} payment={lastPayment} onClose={() => setShowInvoice(false)} />}
      {showOrderShortcuts && canManageSettings && <OrderShortcutsDialog shortcuts={orderShortcuts} onClose={() => setShowOrderShortcuts(false)} onSave={value => { setOrderShortcuts(value); setShowOrderShortcuts(false) }} />}
      {showKitchenTicket && activeOrder && (
        <KitchenTicketPreview
          order={activeOrder}
          tableLabel={selectedTableData ? `TABLE ${selectedTableData.name}` : activeOrder.type === 'delivery' ? formatOrderReference(activeOrder) : 'TAKEAWAY'}
          duplicate={kitchenTicketDuplicate}
          onClose={() => setShowKitchenTicket(false)}
        />
      )}
      {showDeliveryCustomerDialog && activeOrder?.type === 'delivery' && (
        <DeliveryCustomerDialog
          reference={formatOrderReference(activeOrder)}
          order={activeOrder}
          initialValues={{
            customerName: activeOrder.customerName,
            contactNumber: activeOrder.contactNumber,
            deliveryAddress: activeOrder.deliveryAddress,
            deliveryArea: activeOrder.deliveryArea,
            deliveryLandmark: activeOrder.deliveryLandmark,
            deliveryInstructions: activeOrder.deliveryInstructions,
            scheduledDeliveryAt: activeOrder.scheduledDeliveryAt,
          }}
          onBack={() => setShowDeliveryCustomerDialog(false)}
          onStage={stageDeliveryCustomerDetails}
          onDone={completeDeliveryCustomerDetails}
        />
      )}
      {showParcelCustomerDialog && activeOrder?.type === 'parcel' && <ParcelCustomerDialog
        reference={formatOrderReference(activeOrder)} initialNumber={activeOrder.contactNumber}
        onClose={() => setShowParcelCustomerDialog(false)} onSelect={selectParcelCustomer} />}
      {managerDialogMode && (
        <ManagerActionDialog
          key={managerDialogMode}
          mode={managerDialogMode}
          billNumber={activeOrder?.orderNumber}
          onClose={() => { setManagerDialogMode(null); setManagementSetupRequested(false) }}
          onSetPin={handleSetManagerPin}
          onVoid={handleVoidOrder}
        />
      )}
      {deliveryCashOut && <DeliveryCashOutDialog key={deliveryCashOut.requestId} order={deliveryCashOut.order}
        balancePaise={deliveryCashOut.balancePaise} onClose={() => setDeliveryCashOut(null)} onConfirm={confirmDeliveryCashOut} />}
      {cashSummary && !cashSummary.currentOpening && !showManagement && staffHasPermission(staff.role, 'payments:record') &&
        <CashOpeningDialog summary={cashSummary} onOpen={handleOpenCash} onSignOut={handleStaffLogout} />}
      {showManagementPin && <ManagementPinDialog onClose={() => setShowManagementPin(false)} onAuthorize={handleAuthorizeManagement}
        canReset={staff.role === 'owner'} onReset={handleResetManagementPin} />}
      {showItemVoid && activeOrder && (
        <ItemVoidDialog
          order={activeOrder}
          onClose={() => setShowItemVoid(false)}
          onVoid={handleVoidItem}
        />
      )}
      {showSplitBill && activeOrder && <SplitBillDialog order={activeOrder} onClose={() => setShowSplitBill(false)} onSplit={handleSplitBill} />}
      {showJoinBill && <JoinBillDialog orders={joinableBills} selectedOrderId={activeOrder?.id} tables={menu?.tables ?? []} onClose={() => setShowJoinBill(false)} onJoin={handleJoinBills} />}
      {showRecallBill && <RecallBillDialog orders={recallableBills} onClose={() => setShowRecallBill(false)} onRecall={recallBill} />}
      {showDeliveryScheduleDialog && selectedDeliveryNumber !== null && (
        <DeliveryActionDialog
          reference={`HD-${selectedDeliveryNumber}`}
          scheduledDeliveryAt={scheduledDeliveryAt}
          onClose={() => setShowDeliveryScheduleDialog(false)}
          onSave={saveDeliveryDetails}
        />
      )}
      {showHistory && (
        <BillHistoryDialog
          entries={billHistory}
          loading={historyLoading}
          error={historyError}
          onClose={() => setShowHistory(false)}
          onSelect={selectHistoricalBill}
        />
      )}
      {showSavedBills && <SavedBillsDialog orders={savedBills} onClose={closeSavedBills} onSelect={order => void openSavedBill(order)} />}
      {tablePrint && <TablePrintDialog table={tablePrint.table} kind={tablePrint.kind} onClose={closeTablePrint} />}
      {showStaffManagement && canManageStaff && <StaffManagementDialog onClose={() => setShowStaffManagement(false)} />}
      {showPaymentLedger && activeOrder && <PaymentLedgerDialog orderId={activeOrder.id} canRefund={staffHasPermission(staff.role, 'payments:refund')} onClose={() => {
        setShowPaymentLedger(false)
        void Promise.all([getOrder(activeOrder.id), listBillHistory(), refreshMenu()]).then(([order, history]) => {
          setActiveOrder(order); setBillHistory(history); setLastPayment(history.find(entry => entry.order.id === activeOrder.id)?.payment ?? null)
        }).catch(cause => setError(cause instanceof Error ? cause.message : 'Unable to refresh payments.'))
      }} />}
      {showManagement && staffHasPermission(staff.role, 'menu:manage') && <RestaurantManagement staff={staff} theme={theme} onThemeChange={setTheme} cardShortcuts={cardShortcuts} onCardShortcutsChange={setCardShortcuts} orderShortcuts={orderShortcuts} onOrderShortcutsChange={setOrderShortcuts} onClose={() => { setShowManagement(false); void refreshMenu().catch(cause => setError(cause instanceof Error ? cause.message : 'Unable to refresh menu.')) }} />}
      {showWaiter && <WaiterScreen staff={staff} onClose={() => { setShowWaiter(false); void refreshMenu().catch(cause => setError(String(cause))) }} />}
      {showDeliverySchedule && canViewDeliveries && (
        <DeliveryScheduleScreen
          canManageRiders={canManageDeliveryRiders}
          canReassign={canReassignDeliveries}
          onClose={() => void closeDeliverySchedule()}
          onSelectHdCardsForAssignment={beginDeliveryBoardAssignment}
        />
      )}
    </div>
  )
}

export default CashierPage
