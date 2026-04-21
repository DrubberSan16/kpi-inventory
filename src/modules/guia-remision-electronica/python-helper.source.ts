export const SRI_XADES_PYTHON_HELPER = String.raw`
import argparse
import base64
import json
import sys
from datetime import datetime, timezone
from lxml import etree
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.serialization import pkcs12, Encoding, PublicFormat
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.backends import default_backend

DS_NS = 'http://www.w3.org/2000/09/xmldsig#'
ETSI_NS = 'http://uri.etsi.org/01903/v1.3.2#'
NSMAP = {'ds': DS_NS, 'etsi': ETSI_NS}


def canonicalize(element):
    return etree.tostring(element, method='c14n', exclusive=False, with_comments=False)


def sha1_b64(data: bytes) -> str:
    digest = hashes.Hash(hashes.SHA1(), backend=default_backend())
    digest.update(data)
    return base64.b64encode(digest.finalize()).decode('ascii')


def load_credentials(p12_path, password):
    with open(p12_path, 'rb') as fh:
        data = fh.read()
    private_key, certificate, additional = pkcs12.load_key_and_certificates(
        data,
        password.encode('utf-8') if password is not None else None,
        backend=default_backend(),
    )
    if private_key is None or certificate is None:
        raise RuntimeError('No se pudo leer la llave privada o el certificado del archivo p12.')
    return data, private_key, certificate, additional or []


def inspect_p12(args):
    _, private_key, certificate, _ = load_credentials(args.p12_path, args.password)
    public_numbers = private_key.public_key().public_numbers()
    cert_der = certificate.public_bytes(Encoding.DER)
    payload = {
        'subject': certificate.subject.rfc4514_string(),
        'issuer': certificate.issuer.rfc4514_string(),
        'serial_number': str(certificate.serial_number),
        'not_valid_before': certificate.not_valid_before.replace(tzinfo=timezone.utc).isoformat(),
        'not_valid_after': certificate.not_valid_after.replace(tzinfo=timezone.utc).isoformat(),
        'certificate_base64': base64.b64encode(cert_der).decode('ascii'),
        'modulus_base64': base64.b64encode(public_numbers.n.to_bytes((public_numbers.n.bit_length() + 7) // 8, 'big')).decode('ascii'),
        'exponent_base64': base64.b64encode(public_numbers.e.to_bytes((public_numbers.e.bit_length() + 7) // 8, 'big')).decode('ascii'),
        'sha1_digest_base64': sha1_b64(cert_der),
    }
    print(json.dumps(payload))


def sign_xml(args):
    _, private_key, certificate, _ = load_credentials(args.p12_path, args.password)
    with open(args.xml_path, 'rb') as fh:
        xml_bytes = fh.read()

    parser = etree.XMLParser(remove_blank_text=True, resolve_entities=False)
    root = etree.fromstring(xml_bytes, parser=parser)
    if root.get('id') != 'comprobante':
        root.set('id', 'comprobante')

    signature_id = args.signature_id
    signed_info_id = args.signed_info_id
    signed_props_id = args.signed_properties_id
    key_info_id = args.key_info_id
    ref_id = args.reference_id
    object_id = args.object_id
    sig_value_id = args.signature_value_id

    signature = etree.Element(etree.QName(DS_NS, 'Signature'), nsmap=NSMAP)
    signature.set('Id', signature_id)

    signed_info = etree.SubElement(signature, etree.QName(DS_NS, 'SignedInfo'))
    signed_info.set('Id', signed_info_id)
    etree.SubElement(
        signed_info,
        etree.QName(DS_NS, 'CanonicalizationMethod'),
        Algorithm='http://www.w3.org/TR/2001/REC-xml-c14n-20010315'
    )
    etree.SubElement(
        signed_info,
        etree.QName(DS_NS, 'SignatureMethod'),
        Algorithm='http://www.w3.org/2000/09/xmldsig#rsa-sha1'
    )

    ref_signed_props = etree.SubElement(
        signed_info,
        etree.QName(DS_NS, 'Reference'),
        Id=f'{signed_props_id}-ref',
        Type='http://uri.etsi.org/01903#SignedProperties',
        URI=f'#{signed_props_id}'
    )
    etree.SubElement(ref_signed_props, etree.QName(DS_NS, 'DigestMethod'), Algorithm='http://www.w3.org/2000/09/xmldsig#sha1')
    digest_signed_props = etree.SubElement(ref_signed_props, etree.QName(DS_NS, 'DigestValue'))

    ref_keyinfo = etree.SubElement(
        signed_info,
        etree.QName(DS_NS, 'Reference'),
        URI=f'#{key_info_id}'
    )
    etree.SubElement(ref_keyinfo, etree.QName(DS_NS, 'DigestMethod'), Algorithm='http://www.w3.org/2000/09/xmldsig#sha1')
    digest_keyinfo = etree.SubElement(ref_keyinfo, etree.QName(DS_NS, 'DigestValue'))

    ref_document = etree.SubElement(
        signed_info,
        etree.QName(DS_NS, 'Reference'),
        Id=ref_id,
        URI='#comprobante'
    )
    transforms = etree.SubElement(ref_document, etree.QName(DS_NS, 'Transforms'))
    etree.SubElement(transforms, etree.QName(DS_NS, 'Transform'), Algorithm='http://www.w3.org/2000/09/xmldsig#enveloped-signature')
    etree.SubElement(ref_document, etree.QName(DS_NS, 'DigestMethod'), Algorithm='http://www.w3.org/2000/09/xmldsig#sha1')
    digest_document = etree.SubElement(ref_document, etree.QName(DS_NS, 'DigestValue'))

    signature_value = etree.SubElement(signature, etree.QName(DS_NS, 'SignatureValue'))
    signature_value.set('Id', sig_value_id)

    key_info = etree.SubElement(signature, etree.QName(DS_NS, 'KeyInfo'))
    key_info.set('Id', key_info_id)
    x509_data = etree.SubElement(key_info, etree.QName(DS_NS, 'X509Data'))
    x509_certificate = etree.SubElement(x509_data, etree.QName(DS_NS, 'X509Certificate'))
    cert_der = certificate.public_bytes(Encoding.DER)
    x509_certificate.text = base64.b64encode(cert_der).decode('ascii')

    jwk = private_key.public_key().public_bytes(Encoding.DER, PublicFormat.SubjectPublicKeyInfo)
    public_key = serialization.load_der_public_key(jwk, backend=default_backend())
    public_numbers = public_key.public_numbers()
    key_value = etree.SubElement(key_info, etree.QName(DS_NS, 'KeyValue'))
    rsa_key_value = etree.SubElement(key_value, etree.QName(DS_NS, 'RSAKeyValue'))
    modulus = etree.SubElement(rsa_key_value, etree.QName(DS_NS, 'Modulus'))
    modulus.text = base64.b64encode(public_numbers.n.to_bytes((public_numbers.n.bit_length() + 7) // 8, 'big')).decode('ascii')
    exponent = etree.SubElement(rsa_key_value, etree.QName(DS_NS, 'Exponent'))
    exponent.text = base64.b64encode(public_numbers.e.to_bytes((public_numbers.e.bit_length() + 7) // 8, 'big')).decode('ascii')

    obj = etree.SubElement(signature, etree.QName(DS_NS, 'Object'))
    obj.set('Id', object_id)
    qualifying = etree.SubElement(obj, etree.QName(ETSI_NS, 'QualifyingProperties'))
    qualifying.set('Target', f'#{signature_id}')
    signed_properties = etree.SubElement(qualifying, etree.QName(ETSI_NS, 'SignedProperties'))
    signed_properties.set('Id', signed_props_id)
    signed_sig_props = etree.SubElement(signed_properties, etree.QName(ETSI_NS, 'SignedSignatureProperties'))
    signing_time = etree.SubElement(signed_sig_props, etree.QName(ETSI_NS, 'SigningTime'))
    signing_time.text = args.signing_time
    signing_cert = etree.SubElement(signed_sig_props, etree.QName(ETSI_NS, 'SigningCertificate'))
    cert_node = etree.SubElement(signing_cert, etree.QName(ETSI_NS, 'Cert'))
    cert_digest = etree.SubElement(cert_node, etree.QName(ETSI_NS, 'CertDigest'))
    etree.SubElement(cert_digest, etree.QName(DS_NS, 'DigestMethod'), Algorithm='http://www.w3.org/2000/09/xmldsig#sha1')
    cert_digest_value = etree.SubElement(cert_digest, etree.QName(DS_NS, 'DigestValue'))
    cert_digest_value.text = sha1_b64(cert_der)
    issuer_serial = etree.SubElement(cert_node, etree.QName(ETSI_NS, 'IssuerSerial'))
    x509_issuer = etree.SubElement(issuer_serial, etree.QName(DS_NS, 'X509IssuerName'))
    x509_issuer.text = certificate.issuer.rfc4514_string()
    x509_serial = etree.SubElement(issuer_serial, etree.QName(DS_NS, 'X509SerialNumber'))
    x509_serial.text = str(certificate.serial_number)
    signed_data_object_props = etree.SubElement(signed_properties, etree.QName(ETSI_NS, 'SignedDataObjectProperties'))
    data_object_format = etree.SubElement(signed_data_object_props, etree.QName(ETSI_NS, 'DataObjectFormat'))
    data_object_format.set('ObjectReference', f'#{ref_id}')
    desc = etree.SubElement(data_object_format, etree.QName(ETSI_NS, 'Description'))
    desc.text = 'contenido comprobante'
    mime = etree.SubElement(data_object_format, etree.QName(ETSI_NS, 'MimeType'))
    mime.text = 'text/xml'

    # Digest del documento antes de insertar la firma (enveloped)
    digest_document.text = sha1_b64(canonicalize(root))

    # Insertamos la firma para poder canonicalizar correctamente subarboles con namespaces en alcance.
    root.append(signature)

    digest_keyinfo.text = sha1_b64(canonicalize(key_info))
    digest_signed_props.text = sha1_b64(canonicalize(signed_properties))

    signed_info_c14n = canonicalize(signed_info)
    signed_value = private_key.sign(
        signed_info_c14n,
        padding.PKCS1v15(),
        hashes.SHA1(),
    )
    signature_value.text = base64.b64encode(signed_value).decode('ascii')

    final_xml = etree.tostring(root, encoding='UTF-8', xml_declaration=True, pretty_print=False)
    sys.stdout.buffer.write(final_xml)


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='cmd', required=True)

    inspect_cmd = sub.add_parser('inspect')
    inspect_cmd.add_argument('--p12-path', required=True)
    inspect_cmd.add_argument('--password', required=True)
    inspect_cmd.set_defaults(func=inspect_p12)

    sign_cmd = sub.add_parser('sign')
    sign_cmd.add_argument('--p12-path', required=True)
    sign_cmd.add_argument('--password', required=True)
    sign_cmd.add_argument('--xml-path', required=True)
    sign_cmd.add_argument('--signature-id', required=True)
    sign_cmd.add_argument('--signed-info-id', required=True)
    sign_cmd.add_argument('--signed-properties-id', required=True)
    sign_cmd.add_argument('--key-info-id', required=True)
    sign_cmd.add_argument('--reference-id', required=True)
    sign_cmd.add_argument('--object-id', required=True)
    sign_cmd.add_argument('--signature-value-id', required=True)
    sign_cmd.add_argument('--signing-time', required=True)
    sign_cmd.set_defaults(func=sign_xml)

    args = parser.parse_args()
    args.func(args)


if __name__ == '__main__':
    main()
`;
