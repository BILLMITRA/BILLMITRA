const key = 'billmitra.selectedBranch'
export const selectedBranchId = () => sessionStorage.getItem(key) ?? ''
export const selectBranchId = (id: string) => id ? sessionStorage.setItem(key, id) : sessionStorage.removeItem(key)
