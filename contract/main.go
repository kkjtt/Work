package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strconv"
	"strings"

	"chainmaker.org/chainmaker/contract-sdk-go/v2/pb/protogo"
	"chainmaker.org/chainmaker/contract-sdk-go/v2/sandbox"
	"chainmaker.org/chainmaker/contract-sdk-go/v2/sdk"
)

// NFTContract keeps ownership, authorization, listings and demo-credit settlement
// in one ChainMaker transaction. Credits are non-redeemable test units.
type NFTContract struct{}

const maxCredits uint64 = 9007199254740991

type Token struct {
	ID          string `json:"id"`
	Owner       string `json:"owner"`
	Creator     string `json:"creator"`
	CategoryName string `json:"categoryName"`
	Metadata    string `json:"metadata"`
	ContentHash string `json:"contentHash"`
	MetadataHash string `json:"metadataHash"`
	TokenURI    string `json:"tokenURI"`
	LicenseHash string `json:"licenseHash"`
	Approved    string `json:"approved"`
	Burned      bool   `json:"burned"`
	Listed      bool   `json:"listed"`
	Price       uint64 `json:"price"`
	ExpiryHeight uint64 `json:"expiryHeight"`
	OrderNonce  uint64 `json:"orderNonce"`
}

type BatchMintInput struct {
	ID string `json:"id"`
	TokenID string `json:"tokenId"`
	To string `json:"to"`
	CategoryName string `json:"categoryName"`
	Metadata json.RawMessage `json:"metadata"`
	ContentHash string `json:"contentHash"`
	MetadataHash string `json:"metadataHash"`
	TokenURI string `json:"tokenURI"`
	LicenseHash string `json:"licenseHash"`
}

type Record struct {
	AssetID string `json:"assetId,omitempty"`
	Action string `json:"action"`
	Actor string `json:"actor,omitempty"`
	From   string `json:"from,omitempty"`
	To     string `json:"to,omitempty"`
	Price  uint64 `json:"price,omitempty"`
	ExpiryHeight uint64 `json:"expiryHeight,omitempty"`
	OrderNonce uint64 `json:"orderNonce,omitempty"`
	Amount uint64 `json:"amount,omitempty"`
	Approved string `json:"approved,omitempty"`
	BlockHeight uint64 `json:"blockHeight"`
	TxID   string `json:"txId"`
}

func main() {
	if err := sandbox.Start(new(NFTContract)); err != nil { log.Fatal(err) }
}

func (c *NFTContract) InitContract() protogo.Response {
	admin, err := sdk.Instance.Sender()
	if err != nil || admin == "" { return sdk.Error("cannot determine issuer") }
	if err = sdk.Instance.PutStateFromKey("admin", admin); err != nil { return sdk.Error(err.Error()) }
	if err = sdk.Instance.PutStateFromKey("schema_version", "2"); err != nil { return sdk.Error(err.Error()) }
	return sdk.Success([]byte(admin))
}

// Old deployments used slashes in state keys. They may contain balances and
// operator approvals even without tokens, so always require a migration.
func (c *NFTContract) UpgradeContract() protogo.Response {
	version, err := state("schema_version")
	if err != nil { return sdk.Error(err.Error()) }
	if version == "2" { return sdk.Success([]byte("ok")) }
	return sdk.Error("old state keys require a new contract and audited migration")
}

func (c *NFTContract) InvokeContract(method string) protogo.Response {
	var data interface{}
	var err error
	a := sdk.Instance.GetArgs()
	switch method {
	case "Mint": data, err = c.mint(a)
	case "MintBatch": data, err = c.mintBatch(a)
	case "Approve": data, err = c.approve(a)
	case "SetApproval": data, err = c.setApproval(a)
	case "SetApprovalForAll": data, err = c.setApprovalForAll(a)
	case "Transfer": data, err = c.transfer(a)
	case "TransferFrom": data, err = c.transferFrom(a)
	case "TransferFromBatch": data, err = c.transferFromBatch(a)
	case "Burn": data, err = c.burn(a)
	case "List": data, err = c.list(a)
	case "CancelListing": data, err = c.cancelListing(a)
	case "Buy": data, err = c.buy(a)
	case "GrantCredits": data, err = c.grantCredits(a)
	case "GetToken": data, err = c.getToken(a)
	case "ListTokens": data, err = c.listTokens(a)
	case "GetHistory": data, err = c.getHistory(a)
	case "GetEvents": data, err = c.getEvents(a)
	case "GetBlockHeight": data, err = getBlockHeight()
	case "OwnerOf": data, err = c.ownerOf(a)
	case "TokenURI": data, err = c.tokenURI(a)
	case "GetBalance": data, err = c.getBalance(a)
	case "GetOperator": data, err = c.getOperator(a)
	case "GetAdmin": data, err = sdk.Instance.GetStateFromKey("admin")
	case "GetSchemaVersion": data, err = sdk.Instance.GetStateFromKey("schema_version")
	default: err = errors.New("unknown method")
	}
	if err != nil { return sdk.Error(err.Error()) }
	b, err := json.Marshal(data)
	if err != nil { return sdk.Error(err.Error()) }
	return sdk.Success(b)
}

func arg(a map[string][]byte, key string) string { return strings.TrimSpace(string(a[key])) }
func tokenIDArg(a map[string][]byte) string {
	id := arg(a, "id")
	if id == "" { id = arg(a, "tokenId") }
	return id
}
func validateAccount(addr string) error {
	if addr == "" || len(addr) > 128 || strings.ContainsAny(addr, "/ \t\r\n") { return errors.New("invalid account address") }
	return nil
}
// ChainMaker state keys only permit ASCII letters, digits, period, underscore
// and hyphen. Encoding every dynamic component also supports Chinese token IDs.
func keyPart(value string) string { return hex.EncodeToString([]byte(value)) }
func tokenKey(id string) string { return "token." + keyPart(id) }
func historyCountKey(id string) string { return "history_count." + keyPart(id) }
func historyKey(id string, index uint64) string { return fmt.Sprintf("history.%s.%d", keyPart(id), index) }
func balanceKey(addr string) string { return "balance." + keyPart(addr) }
func operatorKey(owner, operator string) string { return "operator." + keyPart(owner) + "." + keyPart(operator) }
func tokenIndexKey(index uint64) string { return fmt.Sprintf("token_index.%d", index) }
func eventKey(index uint64) string { return fmt.Sprintf("event.%d", index) }

func caller() (string, error) {
	v, err := sdk.Instance.Sender()
	if err != nil || v == "" { return "", errors.New("cannot determine caller") }
	return v, nil
}

func state(key string) (string, error) { return sdk.Instance.GetStateFromKey(key) }
func put(key, value string) error { return sdk.Instance.PutStateFromKey(key, value) }

func number(raw string, positive bool) (uint64, error) {
	v, err := strconv.ParseUint(raw, 10, 64)
	if err != nil || (positive && v == 0) || v > maxCredits { return 0, errors.New("invalid positive integer") }
	return v, nil
}

func approvalFlag(raw string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "1", "true": return "1", nil
	case "0", "false": return "0", nil
	default: return "", errors.New("invalid approval flag")
	}
}

func sha256Hex(raw []byte) string {
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func normalizedHash(raw string, required bool) (string, error) {
	hash := strings.ToLower(strings.TrimSpace(raw))
	if hash == "" && !required { return "", nil }
	if len(hash) != 64 { return "", errors.New("hash must be SHA-256 hex") }
	if _, err := hex.DecodeString(hash); err != nil { return "", errors.New("hash must be SHA-256 hex") }
	return hash, nil
}

func stateCount(key string) (uint64, error) {
	raw, err := state(key)
	if err != nil || raw == "" { return 0, err }
	return strconv.ParseUint(raw, 10, 64)
}

func getBlockHeight() (interface{}, error) {
	height, err := sdk.Instance.GetBlockHeight()
	if err != nil { return nil, err }
	if height < 0 { return nil, errors.New("invalid block height") }
	return map[string]uint64{"height": uint64(height)}, nil
}

func (c *NFTContract) load(id string) (Token, error) {
	if id == "" || len(id) > 128 || strings.Contains(id, "/") { return Token{}, errors.New("invalid token id") }
	b, err := state(tokenKey(id))
	if err != nil { return Token{}, err }
	if b == "" { return Token{}, errors.New("token not found") }
	var t Token
	if err := json.Unmarshal([]byte(b), &t); err != nil { return Token{}, err }
	return t, nil
}

func (c *NFTContract) save(t Token) error {
	b, err := json.Marshal(t)
	if err != nil { return err }
	return put(tokenKey(t.ID), string(b))
}

func clearListing(t *Token) {
	t.Listed = false
	t.Price = 0
	t.ExpiryHeight = 0
}

func (c *NFTContract) appendHistory(id string, r Record) error {
	count, err := stateCount(historyCountKey(id))
	if err != nil { return err }
	if count >= maxCredits { return errors.New("history limit reached") }
	r.AssetID = id
	r, err = decorateRecord(r)
	if err != nil { return err }
	b, err := json.Marshal(r)
	if err != nil { return err }
	if err = put(historyKey(id, count), string(b)); err != nil { return err }
	if err = put(historyCountKey(id), strconv.FormatUint(count+1, 10)); err != nil { return err }
	return appendEvent(r)
}

func decorateRecord(r Record) (Record, error) {
	var err error
	r.Actor, err = caller()
	if err != nil { return r, err }
	r.TxID, err = sdk.Instance.GetTxId()
	if err != nil { return r, err }
	height, err := sdk.Instance.GetBlockHeight()
	if err != nil { return r, err }
	if height < 0 { return r, errors.New("invalid block height") }
	r.BlockHeight = uint64(height)
	return r, nil
}

func appendEvent(r Record) error {
	count, err := stateCount("event_count")
	if err != nil { return err }
	if count >= maxCredits { return errors.New("event limit reached") }
	b, err := json.Marshal(r)
	if err != nil { return err }
	if err = put(eventKey(count), string(b)); err != nil { return err }
	if err = put("event_count", strconv.FormatUint(count+1, 10)); err != nil { return err }
	sdk.Instance.EmitEvent("AssetAction", []string{
		r.Action, r.AssetID, r.Actor, r.From, r.To,
		strconv.FormatUint(r.Price, 10), strconv.FormatUint(r.Amount, 10), r.TxID,
		strconv.FormatUint(r.OrderNonce, 10), strconv.FormatUint(r.ExpiryHeight, 10), r.Approved,
	})
	return nil
}

func appendGlobalEvent(r Record) error {
	decorated, err := decorateRecord(r)
	if err != nil { return err }
	return appendEvent(decorated)
}

func (c *NFTContract) isAuthorized(t Token, actor string) (bool, error) {
	if actor == t.Owner || actor == t.Approved { return true, nil }
	v, err := state(operatorKey(t.Owner, actor))
	return v == "1", err
}

func (c *NFTContract) mint(a map[string][]byte) (interface{}, error) {
	actor, err := caller(); if err != nil { return nil, err }
	admin, err := state("admin"); if err != nil { return nil, err }
	if actor != admin { return nil, errors.New("issuer only") }
	id, to := tokenIDArg(a), arg(a, "to")
	if id == "" || strings.Contains(id, "/") || len(id) > 128 { return nil, errors.New("invalid token id") }
	if err = validateAccount(to); err != nil { return nil, err }
	metadata := string(a["metadata"])
	if len(metadata) == 0 || len(metadata) > 8192 { return nil, errors.New("metadata missing or too large") }
	var meta struct { Name string `json:"name"`; Image string `json:"image"`; Author string `json:"author"`; OrgName string `json:"orgName"`; Description string `json:"description"`; SeriesHash string `json:"seriesHash"` }
	if json.Unmarshal(a["metadata"], &meta) != nil || strings.TrimSpace(meta.Name) == "" || strings.TrimSpace(meta.Image) == "" { return nil, errors.New("metadata needs name and image") }
	hash, err := normalizedHash(arg(a, "contentHash"), true)
	if err != nil { return nil, fmt.Errorf("contentHash: %w", err) }
	metadataHash := sha256Hex([]byte(metadata))
	suppliedMetadataHash, err := normalizedHash(arg(a, "metadataHash"), false)
	if err != nil { return nil, fmt.Errorf("metadataHash: %w", err) }
	if suppliedMetadataHash != "" && suppliedMetadataHash != metadataHash { return nil, errors.New("metadataHash does not match metadata") }
	licenseHash, err := normalizedHash(arg(a, "licenseHash"), false)
	if err != nil { return nil, fmt.Errorf("licenseHash: %w", err) }
	uri := arg(a, "tokenURI")
	if len(uri) > 2048 || strings.ContainsAny(uri, "\r\n\t") { return nil, errors.New("invalid tokenURI") }
	categoryName := arg(a, "categoryName")
	if len(categoryName) > 128 { return nil, errors.New("categoryName too long") }
	existing, err := state(tokenKey(id)); if err != nil { return nil, err }
	if existing != "" { return nil, errors.New("token id already used") }
	t := Token{ID:id, Owner:to, Creator:actor, CategoryName:categoryName, Metadata:metadata, ContentHash:hash,
		MetadataHash:metadataHash, TokenURI:uri, LicenseHash:licenseHash}
	count, err := stateCount("token_count"); if err != nil { return nil, err }
	if count >= maxCredits { return nil, errors.New("token limit reached") }
	if err = c.save(t); err != nil { return nil, err }
	if err = put(tokenIndexKey(count), id); err != nil { return nil, err }
	if err = put("token_count", strconv.FormatUint(count+1,10)); err != nil { return nil, err }
	if err = c.appendHistory(id, Record{Action:"Mint", To:to}); err != nil { return nil, err }
	sdk.Instance.EmitEvent("Mint", []string{id, to, hash})
	sdk.Instance.EmitEvent("mint", []string{to, id, categoryName, metadata})
	return t, nil
}

func metadataFromBatch(raw json.RawMessage) ([]byte, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 { return nil, errors.New("metadata required") }
	if trimmed[0] != '"' { return raw, nil }
	var encoded string
	if err := json.Unmarshal(raw, &encoded); err != nil { return nil, err }
	if strings.HasPrefix(strings.TrimSpace(encoded), "{") { return []byte(encoded), nil }
	decoded, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil { return nil, errors.New("metadata must be JSON or base64-encoded JSON") }
	return decoded, nil
}

// MintBatch accepts the CMNFA NFA JSON shape plus the contentHash extension.
// If contentHash is absent, metadata.seriesHash is used as the file digest.
func (c *NFTContract) mintBatch(a map[string][]byte) (interface{}, error) {
	if len(a["tokens"]) > 65536 { return nil, errors.New("tokens payload too large") }
	var inputs []BatchMintInput
	if err := json.Unmarshal(a["tokens"], &inputs); err != nil || len(inputs) == 0 || len(inputs) > 10 {
		return nil, errors.New("tokens must be a JSON array of 1 to 10 items")
	}
	seen := make(map[string]bool, len(inputs))
	results := make([]Token, 0, len(inputs))
	for _, input := range inputs {
		id := input.TokenID
		if id == "" { id = input.ID }
		if id == "" || seen[id] { return nil, errors.New("missing or duplicate token ID") }
		seen[id] = true
		metadata, err := metadataFromBatch(input.Metadata)
		if err != nil { return nil, err }
		contentHash := input.ContentHash
		if contentHash == "" {
			var meta struct { SeriesHash string `json:"seriesHash"` }
			if err = json.Unmarshal(metadata, &meta); err != nil { return nil, err }
			contentHash = meta.SeriesHash
		}
		params := map[string][]byte{
			"id": []byte(id), "to": []byte(input.To),
			"categoryName": []byte(input.CategoryName), "metadata": metadata,
			"contentHash": []byte(contentHash), "metadataHash": []byte(input.MetadataHash),
			"tokenURI": []byte(input.TokenURI), "licenseHash": []byte(input.LicenseHash),
		}
		result, err := c.mint(params)
		if err != nil { return nil, err }
		results = append(results, result.(Token))
	}
	sdk.Instance.EmitEvent("mintBatch", []string{string(a["tokens"])})
	return results, nil
}

func (c *NFTContract) approve(a map[string][]byte) (interface{}, error) {
	t, err := c.load(arg(a,"id")); if err != nil { return nil, err }
	if t.Burned { return nil, errors.New("token burned") }
	actor, err := caller(); if err != nil { return nil, err }
	if actor != t.Owner { return nil, errors.New("owner only") }
	spender := arg(a,"spender")
	if spender != "" { if err = validateAccount(spender); err != nil { return nil,err } }
	if spender == t.Owner { return nil, errors.New("cannot approve owner") }
	t.Approved = spender
	if err = c.save(t); err != nil { return nil, err }
	if err = c.appendHistory(t.ID, Record{Action:"Approve",From:t.Owner,To:spender}); err != nil { return nil, err }
	sdk.Instance.EmitEvent("Approval", []string{t.ID, t.Owner, spender})
	return t, nil
}

// SetApproval accepts the CMNFA-style parameter names while retaining the
// original Approve endpoint for existing clients.
func (c *NFTContract) setApproval(a map[string][]byte) (interface{}, error) {
	owner, err := caller()
	if err != nil { return nil, err }
	if supplied := arg(a, "owner"); supplied != "" && supplied != owner { return nil, errors.New("owner does not match caller") }
	id := tokenIDArg(a)
	to := arg(a, "to")
	approved, err := approvalFlag(arg(a, "isApproval"))
	if err != nil { return nil, err }
	spender := ""
	if approved == "1" {
		if err = validateAccount(to); err != nil { return nil, err }
		spender = to
	}
	result, err := c.approve(map[string][]byte{"id": []byte(id), "spender": []byte(spender)})
	if err != nil { return nil, err }
	sdk.Instance.EmitEvent("setApproval", []string{to, id, strconv.FormatBool(approved == "1")})
	return result, nil
}

func (c *NFTContract) setApprovalForAll(a map[string][]byte) (interface{}, error) {
	owner, err := caller(); if err != nil { return nil, err }
	operator, approved := arg(a,"operator"), arg(a,"approved")
	if supplied := arg(a,"owner"); supplied != "" && supplied != owner { return nil, errors.New("owner does not match caller") }
	if operator == "" { operator = arg(a,"to") }
	if approved == "" { approved = arg(a,"isApproval") }
	approved, err = approvalFlag(approved)
	if err != nil { return nil, err }
	if err = validateAccount(operator); err != nil { return nil,err }
	if operator == owner || (approved != "0" && approved != "1") { return nil, errors.New("invalid operator approval") }
	if err = put(operatorKey(owner,operator), approved); err != nil { return nil, err }
	if err = appendGlobalEvent(Record{Action:"SetApprovalForAll",From:owner,To:operator,Approved:approved}); err != nil { return nil, err }
	sdk.Instance.EmitEvent("ApprovalForAll", []string{owner,operator,approved})
	sdk.Instance.EmitEvent("setApprovalForAll", []string{operator,strconv.FormatBool(approved == "1")})
	return map[string]string{"owner":owner,"operator":operator,"approved":approved}, nil
}

func (c *NFTContract) transfer(a map[string][]byte) (interface{}, error) {
	t, err := c.load(arg(a,"id")); if err != nil { return nil, err }
	to := arg(a,"to")
	if err = validateAccount(to); err != nil { return nil,err }
	if t.Burned || to == t.Owner { return nil, errors.New("invalid transfer") }
	actor, err := caller(); if err != nil { return nil, err }
	ok, err := c.isAuthorized(t,actor); if err != nil { return nil, err }
	if !ok { return nil, errors.New("not authorized") }
	from := t.Owner
	t.Owner, t.Approved = to, ""
	clearListing(&t)
	if err = c.save(t); err != nil { return nil, err }
	if err = c.appendHistory(t.ID, Record{Action:"Transfer",From:from,To:to}); err != nil { return nil, err }
	sdk.Instance.EmitEvent("Transfer", []string{t.ID,from,to})
	return t, nil
}

func (c *NFTContract) transferFrom(a map[string][]byte) (interface{}, error) {
	id := tokenIDArg(a)
	from, to := arg(a,"from"), arg(a,"to")
	t, err := c.load(id)
	if err != nil { return nil, err }
	if from == "" || t.Owner != from { return nil, errors.New("from is not current owner") }
	result, err := c.transfer(map[string][]byte{"id": []byte(id), "to": []byte(to)})
	if err != nil { return nil, err }
	sdk.Instance.EmitEvent("transferFrom", []string{from,to,id})
	return result, nil
}

func (c *NFTContract) transferFromBatch(a map[string][]byte) (interface{}, error) {
	from, to := arg(a,"from"), arg(a,"to")
	if err := validateAccount(from); err != nil { return nil, err }
	if err := validateAccount(to); err != nil { return nil, err }
	if from == to { return nil, errors.New("cannot transfer to current owner") }
	var ids []string
	if err := json.Unmarshal(a["tokenIds"], &ids); err != nil || len(ids) == 0 || len(ids) > 50 {
		return nil, errors.New("tokenIds must be a JSON array of 1 to 50 IDs")
	}
	actor, err := caller()
	if err != nil { return nil, err }
	seen := make(map[string]bool, len(ids))
	for _, id := range ids {
		if seen[id] { return nil, errors.New("duplicate token ID") }
		seen[id] = true
		t, loadErr := c.load(id)
		if loadErr != nil { return nil, loadErr }
		if t.Burned || t.Owner != from { return nil, errors.New("from is not active owner") }
		allowed, authErr := c.isAuthorized(t, actor)
		if authErr != nil { return nil, authErr }
		if !allowed { return nil, errors.New("not authorized") }
	}
	transferred := make([]Token, 0, len(ids))
	for _, id := range ids {
		result, transferErr := c.transfer(map[string][]byte{"id": []byte(id), "to": []byte(to)})
		if transferErr != nil { return nil, transferErr }
		transferred = append(transferred, result.(Token))
	}
	sdk.Instance.EmitEvent("transferFromBatch", []string{from,to,string(a["tokenIds"])})
	return transferred, nil
}

func (c *NFTContract) burn(a map[string][]byte) (interface{}, error) {
	t, err := c.load(arg(a,"id")); if err != nil { return nil, err }
	if t.Burned { return nil, errors.New("token already burned") }
	actor, err := caller(); if err != nil { return nil, err }
	ok, err := c.isAuthorized(t,actor); if err != nil { return nil, err }
	if !ok { return nil, errors.New("not authorized") }
	t.Burned, t.Approved = true, ""
	clearListing(&t)
	if err = c.save(t); err != nil { return nil, err }
	if err = c.appendHistory(t.ID, Record{Action:"Burn",From:t.Owner}); err != nil { return nil, err }
	sdk.Instance.EmitEvent("Burn", []string{t.ID,t.Owner})
	return t, nil
}

func (c *NFTContract) list(a map[string][]byte) (interface{}, error) {
	t, err := c.load(arg(a,"id")); if err != nil { return nil, err }
	actor, err := caller(); if err != nil { return nil, err }
	if t.Burned || actor != t.Owner { return nil, errors.New("active owner only") }
	price, err := number(arg(a,"price"),true); if err != nil { return nil, err }
	var expiryHeight uint64
	if raw := arg(a,"expiryHeight"); raw != "" {
		expiryHeight, err = number(raw,false)
		if err != nil { return nil, errors.New("invalid expiryHeight") }
		if expiryHeight != 0 {
			current, heightErr := sdk.Instance.GetBlockHeight()
			if heightErr != nil { return nil, heightErr }
			if current < 0 || expiryHeight < uint64(current) { return nil, errors.New("listing already expired") }
		}
	}
	if t.OrderNonce >= maxCredits { return nil, errors.New("order nonce limit reached") }
	t.OrderNonce++
	t.Listed, t.Price, t.ExpiryHeight = true, price, expiryHeight
	if err = c.save(t); err != nil { return nil, err }
	if err = c.appendHistory(t.ID, Record{Action:"List",From:t.Owner,Price:price,ExpiryHeight:expiryHeight,OrderNonce:t.OrderNonce}); err != nil { return nil, err }
	sdk.Instance.EmitEvent("List", []string{t.ID,t.Owner,strconv.FormatUint(price,10)})
	return t, nil
}

func (c *NFTContract) cancelListing(a map[string][]byte) (interface{}, error) {
	t, err := c.load(arg(a,"id")); if err != nil { return nil, err }
	actor, err := caller(); if err != nil { return nil, err }
	if !t.Listed || actor != t.Owner { return nil, errors.New("active seller only") }
	previousPrice, previousExpiry := t.Price, t.ExpiryHeight
	clearListing(&t)
	if err = c.save(t); err != nil { return nil, err }
	if err = c.appendHistory(t.ID, Record{Action:"CancelListing",From:actor,Price:previousPrice,ExpiryHeight:previousExpiry,OrderNonce:t.OrderNonce}); err != nil { return nil, err }
	sdk.Instance.EmitEvent("CancelListing", []string{t.ID,actor})
	return t, nil
}

func (c *NFTContract) balance(addr string) (uint64,error) {
	if err := validateAccount(addr); err != nil { return 0,err }
	v, err := state(balanceKey(addr)); if err != nil { return 0, err }
	if v == "" { return 0,nil }
	return strconv.ParseUint(v,10,64)
}

func (c *NFTContract) buy(a map[string][]byte) (interface{}, error) {
	t, err := c.load(arg(a,"id")); if err != nil { return nil, err }
	buyer, err := caller(); if err != nil { return nil, err }
	if t.Burned || !t.Listed || buyer == t.Owner { return nil, errors.New("not available for purchase") }
	if expected := arg(a,"expectedSeller"); expected != "" && expected != t.Owner { return nil, errors.New("seller changed") }
	if expected := arg(a,"expectedPrice"); expected != "" {
		value, parseErr := number(expected,true)
		if parseErr != nil || value != t.Price { return nil, errors.New("price changed") }
	}
	if expected := arg(a,"expectedNonce"); expected != "" {
		value, parseErr := number(expected,true)
		if parseErr != nil || value != t.OrderNonce { return nil, errors.New("listing changed") }
	}
	if t.ExpiryHeight != 0 {
		current, heightErr := sdk.Instance.GetBlockHeight()
		if heightErr != nil { return nil, heightErr }
		if current < 0 || uint64(current) > t.ExpiryHeight { return nil, errors.New("listing expired") }
	}
	buyerBalance, err := c.balance(buyer); if err != nil { return nil, err }
	sellerBalance, err := c.balance(t.Owner); if err != nil { return nil, err }
	if buyerBalance < t.Price || sellerBalance > maxCredits-t.Price { return nil, errors.New("insufficient balance or overflow") }
	seller, price := t.Owner, t.Price
	if err = put(balanceKey(buyer),strconv.FormatUint(buyerBalance-price,10)); err != nil { return nil, err }
	if err = put(balanceKey(seller),strconv.FormatUint(sellerBalance+price,10)); err != nil { return nil, err }
	expiryHeight, nonce := t.ExpiryHeight, t.OrderNonce
	t.Owner, t.Approved = buyer, ""
	clearListing(&t)
	if err = c.save(t); err != nil { return nil, err }
	if err = c.appendHistory(t.ID, Record{Action:"Buy",From:seller,To:buyer,Price:price,ExpiryHeight:expiryHeight,OrderNonce:nonce}); err != nil { return nil, err }
	sdk.Instance.EmitEvent("Buy", []string{t.ID,seller,buyer,strconv.FormatUint(price,10)})
	return t, nil
}

func (c *NFTContract) grantCredits(a map[string][]byte) (interface{}, error) {
	actor, err := caller(); if err != nil { return nil, err }
	admin, err := state("admin"); if err != nil { return nil, err }
	if actor != admin { return nil, errors.New("issuer only") }
	to := arg(a,"to")
	if err = validateAccount(to); err != nil { return nil,err }
	amount, err := number(arg(a,"amount"),true); if err != nil { return nil, err }
	current, err := c.balance(to); if err != nil { return nil, err }
	if current > maxCredits-amount { return nil, errors.New("balance overflow") }
	if err = put(balanceKey(to),strconv.FormatUint(current+amount,10)); err != nil { return nil, err }
	if err = appendGlobalEvent(Record{Action:"GrantCredits",To:to,Amount:amount}); err != nil { return nil, err }
	sdk.Instance.EmitEvent("GrantCredits", []string{to,strconv.FormatUint(amount,10)})
	return map[string]interface{}{"address":to,"balance":current+amount}, nil
}

func (c *NFTContract) getToken(a map[string][]byte) (interface{}, error) { return c.load(arg(a,"id")) }
func (c *NFTContract) ownerOf(a map[string][]byte) (interface{}, error) {
	t, err := c.load(tokenIDArg(a))
	if err != nil { return nil, err }
	if t.Burned { return nil, errors.New("token burned") }
	return t.Owner, nil
}
func (c *NFTContract) tokenURI(a map[string][]byte) (interface{}, error) {
	t, err := c.load(tokenIDArg(a))
	if err != nil { return nil, err }
	if t.Burned { return nil, errors.New("token burned") }
	return t.TokenURI, nil
}
func (c *NFTContract) getBalance(a map[string][]byte) (interface{}, error) {
	addr := arg(a,"address"); v,err := c.balance(addr)
	return map[string]interface{}{"address":addr,"balance":v},err
}
func (c *NFTContract) getOperator(a map[string][]byte) (interface{}, error) {
	owner,operator := arg(a,"owner"),arg(a,"operator")
	if err := validateAccount(owner); err != nil { return nil,err }
	if err := validateAccount(operator); err != nil { return nil,err }
	v,err := state(operatorKey(owner,operator))
	return map[string]interface{}{"owner":owner,"operator":operator,"approved":v=="1"},err
}
func (c *NFTContract) listTokens(a map[string][]byte) (interface{}, error) {
	offset,_ := strconv.ParseUint(arg(a,"offset"),10,64)
	limit,_ := strconv.ParseUint(arg(a,"limit"),10,64)
	if limit == 0 || limit > 100 { limit = 20 }
	count,err := stateCount("token_count"); if err != nil { return nil,err }
	items := make([]Token,0)
	for i:=offset; i<count && uint64(len(items))<limit; i++ {
		id,err := state(tokenIndexKey(i)); if err != nil { return nil,err }
		t,err := c.load(id); if err != nil { return nil,err }
		items = append(items,t)
	}
	return map[string]interface{}{"total":count,"items":items},nil
}
func (c *NFTContract) getHistory(a map[string][]byte) (interface{}, error) {
	id := arg(a,"id")
	if _,err := c.load(id); err != nil { return nil,err }
	count,err := stateCount(historyCountKey(id)); if err != nil { return nil,err }
	offset,_ := strconv.ParseUint(arg(a,"offset"),10,64)
	limit,_ := strconv.ParseUint(arg(a,"limit"),10,64)
	if limit == 0 || limit > 100 { limit = 20 }
	items := make([]Record,0)
	for i:=offset; i<count && uint64(len(items))<limit; i++ {
		v,err := state(historyKey(id,i)); if err != nil { return nil,err }
		var r Record
		if err = json.Unmarshal([]byte(v),&r); err != nil { return nil,err }
		items = append(items,r)
	}
	return map[string]interface{}{"total":count,"items":items},nil
}

func (c *NFTContract) getEvents(a map[string][]byte) (interface{}, error) {
	offset, _ := strconv.ParseUint(arg(a,"offset"),10,64)
	limit, _ := strconv.ParseUint(arg(a,"limit"),10,64)
	if limit == 0 || limit > 100 { limit = 20 }
	count, err := stateCount("event_count")
	if err != nil { return nil, err }
	items := make([]Record,0)
	for i:=offset; i<count && uint64(len(items))<limit; i++ {
		v, err := state(eventKey(i))
		if err != nil { return nil, err }
		var record Record
		if err = json.Unmarshal([]byte(v), &record); err != nil { return nil, err }
		items = append(items, record)
	}
	return map[string]interface{}{"total":count,"items":items}, nil
}
